require('dotenv').config();
const express = require('express');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4 } = require('uuid');
const { Level, log, generatePlayerToken } = require('./util.js');

const config = {
    // Which port the express server runs on
    express_port: 3000,

    // Websockets port
    wss_port: 3001,

    // Session cleanup time - remove stale sessions >= this time
    cleanup_time: 3600000,

    // Ping interval (in ms)
    ping_interval: 200,

    // Number of samples to average ping over
    ping_max_samples: 10,

    // [Default] Time allotted for each question
    question_time: 5000,

    // [Default] Max wait time in ms (for slow clients)
    max_wait_time: 2000,

    // [Default] Whether or not to have a short cooldown for pressing the buzzer too early
    buzzer_cooldown: false
}

const app = express()
const wss = new WebSocket.Server({ port: config.wss_port });

/*
    Sessions are JSON objects that track the state of a game and its players
    {
        players: new Map([
            [
                'token',                                // Player's token is the key           
                {
                    steamID: undefined,                 // Steam64ID of the connected player
                    ws: undefined,                      // The websocket instance for the player
                    pings: new Map([
                        [
                            'ping-guid',                // UUID of the ping (to prevent spoofing)
                            {
                                ping_id: '',            // ID of the last ping
                                ping_time: undefined    // Datetime the ping_id above was generated
                            }
                        ]
                    ]),
                    ping_tracker: [],                   // History of pings to this client
                    ping_total: 0                       // Running total of pings over the amount of pings in ping_tracker
                    ping: 0                             // Calculated ping
                }       
            ]
        ]),
        timer: undefined,                               // The timer for response timeout
        pendingRes: undefined,                          // Pending web request to get the winner of a buzz
        buzzes: [],                                     // Buzzes for the current question
        config: {},                                     // Config for this session
        lastActivity = new Date()                       // Last time there was activity on this session
    }
*/
const sessions = new Map();

const acceptBuzzing = JSON.stringify({ type: 'accept_buzz' });
const denyBuzzing = JSON.stringify({ type: 'deny_buzz' });

// Static web pages
app.use(express.static(path.join(__dirname, 'public')));

// API endpoints
app.post('/api/session', startSession);                                     // Creates a new Jeopardy session
app.put('/api/session/:sessionID', editSessionConfig);                      // Edits a session's configuration
app.post('/api/session/:session/player', registerPlayers);                  // Register players to a session
app.delete('/api/session/:session/player', unregisterPlayers);              // Unregisters players from a session
app.post('/api/session/:session/buzzer', unlockBuzzer);                     // RPC to unlock the buzzer for players
app.get('/api/player', getSteamPlayerInformation);                          // RPC to get player information from Steam

// [Job] Clean up old sessions and players after an hour of inactivity
setInterval(() => {
    for(const [sessionID, sessionData] of sessions.entries()) {
        // How long ago we last saw any activity from this
        const lastSeen = new Date() - sessionData.lastActivity;

        log(Level.DEBUG, `Session ID '${sessionID} last saw usage ${lastSeen / 1000} seconds ago.`);

        // Clean up sessions with no activity over the last hour
        if(lastSeen >= 3600000) {
            sessions.delete(sessionID);
            log(Level.INFO, `Session ID '${sessionID}' was cleaned up. Last activity: ${sessionData.lastActivity.toISOString()}`)
        }
    }
}, 60000);

// [Job] Ping connected players to find average latency
setInterval(() => {
    const newPingID = v4();
    const pingMessage = JSON.stringify({ type: 'ping', ping_id: newPingID});
    for(const session of sessions.values()) {
        for(const player of session.players.values()) {
            player.pings.set(newPingID, new Date());
    
            try {
                if(player.ws != undefined)
                    player.ws.send(pingMessage);
            } catch(error) {
                log(Level.ERROR, `Error sending websocket message to ${player.steamID}: ${error}`);
            }
        }
    }
}, config.ping_interval);

// [Job] Update connected players for opponents' ping
setInterval(() => {
    var pingData = [];
    for(const session of sessions.values()) {
        for(const player of session.players.values()) {
            // Give a -1 value for ping for players who are registered, but haven't connected yet
            pingData.push({
                steamID: player.steamID,
                ping: player.ping_tracker.length > 0 && player.ws != undefined ? player.ping : -1
            });
        }
    }

    const pingMessage = JSON.stringify({ type: 'ping_list', players: pingData});

    for(const session of sessions.values()) {
        for(const player of session.players.values()) {
            try {
                if(player.ws != undefined)
                    player.ws.send(pingMessage);
            } catch(error) {
                log(Level.ERROR, `Error sending websocket message to ${token}: ${error}`);
            }
        }
    }
}, config.ping_interval * config.ping_max_samples);

wss.on('connection', (ws, req) => {
    // Retrieve the bearer token from the URL query parameter
    const token = new URLSearchParams(req.url).get('/?token');
    var sessionID;
    // Get the player's session ID from the token
    for(const [id, session] of sessions.entries()) {
        for(const playerToken of session.players.keys()) {
            if(token == playerToken) {
                sessionID = id;
                break;
            }
        }
        if(sessionID != undefined) break;
    }

    if(token == undefined || sessionID == undefined) {
        log(Level.WARN, `User tried to connect using an invalid token: ${token}`);
        ws.send(JSON.stringify({ type:'close', message: 'This token is not valid.' }));
        ws.close();
        return;
    }

    // Disallow connections for tokens that already have an active connection
    if(sessions.get(sessionID).players.get(token).ws != undefined) {
        log(Level.WARN, `User tried to connect using a token already in use: ${token}`);
        ws.send(JSON.stringify({ type:'close', message: 'This token is currently in use by another session.' }));
        ws.close();
        return;
    }

    sessions.get(sessionID).players.get(token).ws = ws;
    log(Level.INFO, `New player connection. Token: ${token}`);
  
    ws.on('message', (request) => {
        var message;
        try {
            message = JSON.parse(request);
        } catch(error) {
            log(Level.ERROR, `Message sent to websocket could not be parsed. Error message:`);
            console.log(error);
            log(Level.ERROR, `Message sent from client:`);
            console.log(message);
            return;
        }

        switch(message.type) {
            case 'buzz':
                // do something for buzzes
                handleBuzz(message);
                break;
            case 'pong':
                // returning ping request
                handlePong(message);
                break;
            default:
                // Unknown message - log, but don't return any information
                log(Level.ERROR, `Unknown message from player with token '${token}':`);
                console.log(message);
                break;
        }
    });

    ws.on('close', (request) => {
        try {
            if(sessions.has(sessionID) && sessions.get(sessionID).players.has(token)) {
                sessions.get(sessionID).players.get(token).ws = undefined;
                log(Level.INFO, `Player with token '${token}' has disconnected.`);
            }
        } catch (error) {
            console.log(`Something went wrong with the request: ${error}`);
        }
    });

    function handleBuzz(message) {
        // Only if we're accepting buzzes or if player hasn't buzzed in yet
        if(sessions.get(sessionID).pendingRes == undefined || sessions.get(sessionID).buzzes.has(token)) return;

        sessions.get(sessionID).buzzes.set(token, new Date() - sessions.get(sessionID).players.get(token).ping)
        
        log(Level.INFO, `Player with token ${token} has buzzed in at: ${message.time}`)

        if(sessions.get(sessionID).buzzes.size == 1) {
            clearTimeout(sessions.get(sessionID).timer);
            sessions.get(sessionID).timer = setTimeout(() => {
                var winner = undefined;
                for(const [playerToken, player] of sessions.get(sessionID).players.entries()) {
                    try {
                        player.ws.send(denyBuzzing);
                    } catch(error) {
                        log(Level.ERROR, `Error sending websocket message to ${player}: ${error}`);
                    }

                    if(winner == undefined || sessions.get(sessionID).buzzes.get(player) < winner.time) {
                        winner = {
                            token: playerToken,
                            time: sessions.get(sessionID).buzzes.get(playerToken)
                        };
                    }
                }
                log(Level.INFO, `Session ${sessionID} buzzer winner is token '${winner.token}' with time: ${winner.time}`);
                sessions.get(sessionID).pendingRes.status(200).send(JSON.stringify({ winner: token }));
                sessions.get(sessionID).timer = undefined;
                sessions.get(sessionID).pendingRes = undefined;
                sessions.get(sessionID).buzzes.clear();
            }, config.max_wait_time)
        }
    }

    function handlePong(message) {
        if(!sessions.has(sessionID) || !sessions.get(sessionID).players.has(token)) return;

        const player = sessions.get(sessionID).players.get(token);

        if(!player.pings.has(message.ping_id)) return;

        const ping_time = Math.round(new Date() - player.pings.get(message.ping_id));

        // 
        if(player.ping_tracker.length >= config.ping_max_samples) {
            player.ping_total -= player.ping_tracker.shift();
        }
        player.ping_total += ping_time;
        player.ping_tracker.push(ping_time);
        player.ping = Math.round((player.ping_total + ping_time) / player.ping_tracker.length);

        player.pings.delete(message.ping_id);
    }
});

http.createServer(app).listen(config.express_port);

log(Level.INFO, `Jeopardy buzzer application started!`);

function startSession(req, res) {
    const uuid = v4();

    // Just assume that the uuid doesn't exist as a key in the map
    sessions.set(uuid, {
        players: new Map(),
        timer: undefined,
        pendingRes: undefined,
        buzzes: new Map(),
        config: {
            // Time allotted for each question
            question_time: config.question_time,

            // Max wait time in ms (for slow clients)
            max_wait_time: config.max_wait_time,

            // Whether or not to have a short cooldown for pressing the buzzer too early
            buzzer_cooldown: config.buzzer_cooldown
        },
        lastActivity: new Date()
    });

    log(Level.INFO, `Started new Jeopardy session: ${uuid}`);

    res.status(200).send(JSON.stringify({ sessionID: uuid }));
}

function editSessionConfig(req, res) {
    const sessionID = req.params.session;
    const question_time = req.query.question_time;
    const max_wait_time = req.query.max_wait_time;
    const buzzer_cooldown = req.query.buzzer_cooldown;

    // Session doesn't exist - return success so session IDs can't be derived
    if(!sessions.has(sessionID)) {
        res.status(200).send({ status: 'success' });
        return;
    }

    // Just assume that the uuid doesn't exist as a key in the map
    var sessionConfig = sessions.get(sessionID);

    try {
        if(question_time != undefined && typeof(question_time) === 'number' && Number(question_time) > 0)
            sessionConfig.question_time = question_time;

        if(max_wait_time != undefined && typeof(max_wait_time) === 'number' && Number(max_wait_time) > 0)
            sessionConfig.max_wait_time = max_wait_time;

        if(buzzer_cooldown != undefined && typeof(buzzer_cooldown) === 'boolean')
            sessionConfig.buzzer_cooldown = buzzer_cooldown;
    } catch(error) {
        log(Level.ERROR, `Error updating config for session ID '${sessionID}:`);
        console.log(error);
        log(Level.ERROR, `Config values from client:`);
        console.log(JSON.stringify(
            {
                question_time: req.query.question_time,
                max_wait_time: req.query.max_wait_time,
                buzzer_cooldown: req.query.buzzer_cooldown
            }
        ));

        res.status(200).send({ status: 'error', message: `One or more of the configuration values passed is not valid.` });
        return;
    }

    res.status(200).send({ status: 'success' });

    sessions.get(sessionID).lastActivity = new Date();
}

function registerPlayers(req, res) {
    const sessionID = req.params.session;
    const steamIDs = req.query.steamIDs;

    // Session ID is invalid
    if(!sessions.has(sessionID)) {
        res.status(200).send(JSON.stringify({ status: 'error', message: 'Invalid session ID provided.' }));
        return;
    }

    var response = [];

    for(const steamID of steamIDs.split(',')) {
        var token;
        // See if this player has been previously registered
        for(const [playerToken, player] of sessions.get(sessionID).players.entries()) {
            if(player.steamID == steamID) {
                token = playerToken;
                break;
            }
        }

        if(token == undefined) {
            token = generatePlayerToken();
            sessions.get(sessionID).players.set(token, {
                steamID: steamID,
                ws: undefined,
                pings: new Map(),
                ping_tracker: [],
                ping_total: 0,
                ping: 0
            });
            log(Level.INFO, `Registering Steam ID '${steamID}' for session ID '${sessionID}'. Token: ${token}`);
        } else {
            log(Level.INFO, `Steam ID '${steamID}' has been re-registered for session ID '${sessionID}'. Using the same token: ${token}`);
        }

        response.push({
            steamID: steamID,
            token: token
        });
    }

    res.status(200).send(JSON.stringify(response));

    sessions.get(sessionID).lastActivity = new Date();
}

function unregisterPlayers(req, res) {
    const sessionID = req.params.session;
    const tokens = req.query.tokens;

    // Session ID is invalid
    if(!sessions.has(sessionID)) {
        res.status(200).send(JSON.stringify({ status: 'error', message: 'Invalid session ID provided.' }));
        return;
    }

    for(const token of tokens.split(',')) {
        // Ignore any players that haven't been previously registered
        if(!sessions.get(sessionID).players.has(token)) continue;

        const steamID = sessions.get(sessionID).players.get(token).steamID;

        // Remove specified player
        sessions.get(sessionID).players.delete(token);

        log(Level.INFO, `Unregistered Steam ID '${steamID}' for session ID '${sessionID}'. Token: ${token}`);
    }

    res.status(200).send(JSON.stringify({ status: 'success' }));

    sessions.get(sessionID).lastActivity = new Date();
}

function unlockBuzzer(req, res) {
    const sessionID = req.params.session;

    // Don't even give the client a reply
    if(!sessions.has(sessionID)) return;

    log(Level.INFO, `Buzzer for session ID '${sessionID}' unlocked.`);
    
    // Unlocks buzzers for connected players
    for(const player of sessions.get(sessionID).players.values()) {
        try {
            player.ws.send(acceptBuzzing);
        } catch(error) {
            log(Level.ERROR, `Error sending websocket message to ${player}: ${error}`);
        }
    }

    sessions.get(sessionID).pendingRes = res;

    sessions.get(sessionID).timer = setTimeout(() => {
        for(const player of sessions.get(sessionID).players.values()) {
            try {
                player.ws.send(denyBuzzing);
            } catch(error) {
                log(Level.ERROR, `Error sending websocket message to ${player}: ${error}`);
            }
        }
        log(Level.INFO, `Nobody buzzed in for session ID ${sessionID}.`);
        res.status(200).send(JSON.stringify({ winner: undefined }));
        sessions.get(sessionID).timer = undefined;
        sessions.get(sessionID).pendingRes = undefined;
        sessions.get(sessionID).buzzes.clear();
    }, config.question_time + config.max_wait_time)

    sessions.get(sessionID).lastActivity = new Date();
}

async function getSteamPlayerInformation(req, res) {
    if(process.env.STEAM_API_KEY == undefined) {
        res.status(200).send(JSON.stringify({ status: 'error', message: 'No Steam API key provided server-side.' }));
        return;
    }

    const steamIDs = req.query.steamIDs;

    try {
        const response = (await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&format=json&steamids=${steamIDs}`)).data.response;

        var players = [];

        if(response && response.players && response.players.length > 0) {

          for(const player of response.players) {
            players.push({
                profileName: player.personaname,
                profilePicture: player.avatar
            });
          }
        }
      } catch(error) {
        log(Level.ERROR, `Error getting data from Steam API: ${error}`);
        res.status(200).send(JSON.stringify({ status: 'error', message: 'An unexpected error occurred getting Steam profile information.' }));
      }
      res.status(200).send(JSON.stringify({ status: 'success', players: players }));
}