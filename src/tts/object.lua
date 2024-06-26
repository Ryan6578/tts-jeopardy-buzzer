-- Web buzzer variables
webBuzzerUrl = 'https://j.robford.me'
webBuzzerSessionID = nil
webBuzzerPlayerMap = {}

-- Jeopardy script objects
scriptObject = getObjectFromGUID('a94ab1')
hostObject = getObjectFromGUID('90fc80')

-- Table for player colors (including host)
playerColors = {'Blue', 'Brown', 'Green', 'Orange', 'Pink', 'Purple', 'Red', 'Teal', 'White', 'Yellow'}

function onLoad()
    -- Delete this object if there's already a web buzzer
    local buzzerModSpawned = scriptObject.getVar('buzzerModSpawned')
    if buzzerModSpawned ~= nil and buzzerModSpawned ~= self.guid then
        self.destroy()
        printToAll('Only one Jeopardy web buzzer can be spawned in a game session.')
        return
    end

    if buzzerModSpawned == nil then
        scriptObject.setVar('buzzerModSpawned', self.guid)

        log('Jeopardy web buzzer object spawned for the first time. Checking for updates...')

        -- Update the buzzer mod to the latest version on GitHub (starting with XML first)
        WebRequest.get("https://raw.githubusercontent.com/Ryan6578/tts-jeopardy-buzzer/main/src/tts/object.xml", function(xmlRequest)
            if xmlRequest.is_error then
                log(xmlRequest.error)
                printToAll('An error occurred while trying to get the XML for the Jeopardy web buzzer object from GitHub! Check the logs tab for more information.')
            else
                -- Set the XML accordingly
                self.UI.setXml(xmlRequest.text)

                log('Latest XML successfully retrieved and set from GitHub.')

                -- Request the LUA for this object
                WebRequest.get("https://raw.githubusercontent.com/Ryan6578/tts-jeopardy-buzzer/main/src/tts/object.lua", function(luaRequest)
                    if luaRequest.is_error then
                        log(request.error)
                        printToAll('An error occurred while trying to get the LUA for the Jeopardy web buzzer object from GitHub! Check the logs tab for more information.')
                    else
                        -- Set the LUA accordingly
                        self.setLuaScript(luaRequest.text)

                        log('Latest LUA successfully retrieved and set from GitHub.')

                        Wait.frames(function()
                            -- Reload this object with the updated XML and LUA
                            --self.reload()
                            getObjectFromGUID(self.guid).call('onLoad')

                            log('Jeopardy web buzzer object reloaded with latest updates from GitHub.')
                        end, 500)
                    end
                end)
            end
        end)

        return
    end

    -- Disable all other buzzer modes
    scriptObject.setVar('buzzerSpam', false)
    scriptObject.setVar('buzzerContest', false)
    scriptObject.setVar('randomBuzzers', false)

    -- Edit the 'Unlock Buzzers' button
    for buttonIndex, buttonData in ipairs(hostObject.getButtons()) do
        if buttonData.label == 'Unlock Buzzers' then
            hostObject.editButton({index= buttonIndex - 1, click_function = "unlockWebBuzzer", function_owner = self})
        end
    end

    -- Global function override (TODO later)
    --_G = scriptObject.getVar('_G')
    --_G['unlockBuzzersUI'] = function(player) unlockWebBuzzer(nil, host) end
    --scriptObject.setVar('_G', _G)

    -- Hotkey overrides
    clearHotkeys()
    addHotkey('[1E12BA]Contestant:[-] Activate buzzer', function(pColor) playBuzz(pColor) end, false)
    addHotkey('[1E12BA]Host:[-] Unlock buzzers', function(pColor) unlockWebBuzzer(nil, pColor) end, false)

    -- Start a web buzzer session
    WebRequest.post(webBuzzerUrl .. '/api/session', {}, function(request)
        if request.is_error then
            print("Web buzzer request failed: " .. request.error)
            return
        end

        local responseData = JSON.decode(request.text)

        if responseData.sessionID ~= nil then
            webBuzzerSessionID = responseData.sessionID
            log('Web buzzer session ID: ' .. webBuzzerSessionID)

            -- Register all seated players
            local seatedPlayers = ''
            for i, color in ipairs(playerColors) do 
                if color ~= 'Teal' and Player[color].seated then
                    seatedPlayers = (seatedPlayers .. (seatedPlayers == '' and Player[color].steam_id or (',' .. Player[color].steam_id)))
                end
            end

            if seatedPlayers == '' then
                -- No players to register
                return
            end

            WebRequest.post(webBuzzerUrl .. '/api/session/' .. webBuzzerSessionID .. '/player?steamIDs=' .. seatedPlayers, {}, function(request)
                if request.is_error then
                    print("Web buzzer request failed: " .. request.error)
                    return
                end
    
                local responseData = JSON.decode(request.text)
    
                webBuzzerLinks = responseData
    
                startLuaCoroutine(self, 'setLinksAndQRCodes')

                printToAll('Web buzzer loaded successfully. Please scan the QR code or copy/paste the link into a browser to buzz in.')
            end)
        end
    end)
end

function onPlayerAction(player, action, targets)
    if(action == Player.Action.Delete) then
        -- Prevent this object from being deleted (but delete other objects)
        local includesSelf = false
        for _, target in ipairs(targets) do
            if target == self then
                includesSelf = true
            else
                target.destroy()
            end

            if includesSelf then
                player.print('The Jeopardy web buzzer cannot be deleted. Please reload the Jeopardy game to reset.')
            end
        end
        return false
    end
    return true
end

function onPlayerChangeColor(playerColor)
    if playerColor != nil and playerColor != 'Grey' and playerColor != 'Black' and playerColor != 'Teal' then
        local player = Player[playerColor].steam_id
        WebRequest.post(webBuzzerUrl .. '/api/session/' .. webBuzzerSessionID .. '/player?steamIDs=' .. player, {}, function(request)
            if request.is_error then
                print("Web buzzer request failed: " .. request.error)
                return
            end

            local responseData = JSON.decode(request.text)

            webBuzzerLinks = responseData

            startLuaCoroutine(self, 'setLinksAndQRCodes')

            Player[playerColor].print('This server is using a web buzzer mod for buzzing in. Please scan the QR code or copy/paste the link into a browser to buzz in.')
        end)
    end
end

function onPlayerDisconnect(player)
        -- Get a list of players that have left (in case we have stragglers)
        local playersToUnregister = ''
        for token, steamID in pairs(webBuzzerPlayerMap) do
            if findColorBySteamID(steamID) == nil then
                playersToUnregister = (playersToUnregister .. (playersToUnregister == '' and token or (',' .. token)))
                webBuzzerPlayerMap[token] = nil
            end
        end

        -- Unregister players from the game (regardless of what color they changed from)
        WebRequest.delete(webBuzzerUrl .. '/api/session/' .. webBuzzerSessionID .. '/player?tokens=' .. playersToUnregister, function(request)
            if request.is_error then
                print("Unregister player request failed: " .. request.error)
                return
            end
        end)
end

function onChat(message, player)

    if not player.admin and not player.host then
        -- Player isn't authorized to run commands
        return true
    end

    local command = {}
    for arg in string.gmatch(message, "[^%s]+") do
        table.insert(command, arg)
    end

    if command[1]:lower() ~= "!jwb" then
        -- Command isn't for the Jeopardy web buzzer
        return true
    end

    -- Command must inclue a sub-command
    if #command < 2 then
        player.print("ERROR: Expected a sub-command to !jwb.")
        return false
    end

    local subCommand = command[2]:lower()

    if command == "beta" then
        -- Switch to the beta branch
        player.print("Coming soon!")

    elseif subCommand == "prod" then
        -- Switch to the main branch
        player.print("Coming soon!")
    
    elseif subCommand == "genplayer" then
        -- Generate a virtual player based on a specified Steam64ID
        if #command ~= 3 then
            -- Need a third arg for the Steam64ID
            player.print("ERROR: Expected a sub-command to !jwb.")
            return false
        end

        WebRequest.post(webBuzzerUrl .. '/api/session/' .. webBuzzerSessionID .. '/player?steamIDs=' .. command[3], {}, function(request)
            if request.is_error then
                print("Web buzzer request failed: " .. request.error)
                return
            end

            local responseData = JSON.decode(request.text)

            webBuzzerLinks = responseData

            startLuaCoroutine(self, 'setLinksAndQRCodes')

            player.print('Generated buzzer link for player "' .. responseData[1].steamID .. '": ' .. webBuzzerUrl .. '/?token=' .. responseData[1].token )
        end)

    elseif subComment == "help" then
        -- Help page for the mod
        player.print("Coming soon!")

    else
        -- Unknown subcommand
        player.print("ERROR: Unknown sub-command.") 

    end

    return false

end

function setLinksAndQRCodes()
    for _,data in ipairs(webBuzzerLinks) do
        webBuzzerPlayerMap[data.token] = data.steamID
        -- QR code
        self.UI.setCustomAssets(table.insert(self.UI.getCustomAssets(), {name = data.token, url = 'https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=https://j.robford.me/?token=' .. data.token}))
        coroutine.yield(0)
        local playerColor = findColorBySteamID(data.steamID)
        if playerColor ~= nil then
            Wait.frames(function()
                self.UI.setAttribute(playerColor .. 'QR', 'image', data.token)
                self.UI.setAttribute(playerColor .. 'Text', 'text', webBuzzerUrl .. '/?token=' .. data.token)
            end, 240)
        end
        coroutine.yield(0)
    end
    return 1
end

function findColorBySteamID(steamID)
    for _,player in ipairs(Player.getPlayers()) do 
        if player.steam_id == steamID then
            return player.color
        end
    end
    return nil
end

--[[
    Functions to inject into the parent Jeopardy script.
--]]

function unlockWebBuzzer(obj, pColor)
    if pColor == scriptObject.getVar('host') and scriptObject.getVar('buzzerLocked') and not scriptObject.getVar('isDD') then
        scriptObject.setVar('buzzerLocked', false)
        scriptObject.call('resetNametagBorders')

        scriptObject.call('showBoardLights')

        --Start timer if it's not a daily double
        if scriptObject.getVar('qValue') != 0 then
            scriptObject.setVar('countdownActive', true)
            startLuaCoroutine(self, 'webBuzzerRoutine')
        end
    end
end

function webBuzzerRoutine()
    WebRequest.post(webBuzzerUrl .. '/api/session/' .. webBuzzerSessionID .. '/buzzer', {}, function(request)
        if request.is_error then
            print("Web buzzer request failed: " .. request.error)
            return
        end

        local responseData = JSON.decode(request.text)

        if responseData.winner ~= nil then
            scriptObject.setVar('countdownActive', false)

            local randomBuzzerWinner = findColorBySteamID(webBuzzerPlayerMap[responseData.winner])

            if randomBuzzerWinner ~= nil then
                broadcastToAll(Player[randomBuzzerWinner].steam_name .. ' buzzed in first!')
            else
                -- Assume this is a generated player
                broadcastToAll(webBuzzerPlayerMap[responseData.winner] .. ' buzzed in first!')
            end

            getObjectFromGUID('9fd549').AssetBundle.playTriggerEffect(0)
            scriptObject.call('hideBoardLights')
            scriptObject.call('resetRandomBuzzers')
            scriptObject.call('lockBuzzers')
            
            --Animate nametag and buzzer (only if buzzer winner isn't nil)
            if randomBuzzerWinner ~= nil then
                buzzerIndex = scriptObject.call('getButtonIndex', 'buzzerLabel' .. randomBuzzerWinner .. 'Click')
                --buzzerIndex = getButtonIndex('buzzerLabel' .. randomBuzzerWinner .. 'Click')
                local buzzerY = 1.5
                scriptObject.editButton({index = buzzerIndex, font_color = {1, 1, 1}})
            end

            --[[for i = 0.01, 2, 0.01 do
                Wait.time(function()
                    --Constrict the nametag cover's X scale
                    nametagCover[randomBuzzerWinner].scale({1 - (i / 1.99), 1, 1})

                    --Raise and fade out the BUZZ! text effect
                    if colorData[randomBuzzerWinner]['direction'] == 'N' then
                        self.editButton({index = buzzerIndex, font_color = {1, 1, 1, (2 - i) / 2}, position = {x = colorData[randomBuzzerWinner]['posX'], y = buzzerY + i, z = colorData[randomBuzzerWinner]['posZ'] - 5}})
                    elseif colorData[randomBuzzerWinner]['direction'] == 'S' then
                        self.editButton({index = buzzerIndex, font_color = {1, 1, 1, (2 - i) / 2}, position = {x = colorData[randomBuzzerWinner]['posX'], y = buzzerY + i, z = colorData[randomBuzzerWinner]['posZ'] + 5}})
                    elseif colorData[randomBuzzerWinner]['direction'] == 'E' then
                        self.editButton({index = buzzerIndex, font_color = {1, 1, 1, (2 - i) / 2}, position = {x = colorData[randomBuzzerWinner]['posX'] + 5, y = buzzerY + i, z = colorData[randomBuzzerWinner]['posZ']}})
                    elseif colorData[randomBuzzerWinner]['direction'] == 'W' then
                        self.editButton({index = buzzerIndex, font_color = {1, 1, 1, (2 - i) / 2}, position = {x = colorData[randomBuzzerWinner]['posX'] - 5, y = buzzerY + i, z = colorData[randomBuzzerWinner]['posZ']}})
                    end
                end, i/4)
            end]]
            
            scriptObject.setVar('timerActive', true)
            startLuaCoroutine(scriptObject, 'timerRoutine')
        end

        if scriptObject.getVar('countdownActive') then
            getObjectFromGUID('9fd549').AssetBundle.playTriggerEffect(1)
            scriptObject.call('lockBuzzers')
            scriptObject.call('hideFullscreenQuestion', scriptObject.getVar('host'))
            scriptObject.call('resetRandomBuzzers')
            --analyticsUpdate()
    
            local invisibleColors = scriptObject.call('shallowCopy', playerColors)
            if scriptObject.getVar('answer') != '' then
                for i, v in pairs(invisibleColors) do
                    if Player[v].seated and v != scriptObject.getVar('host') then broadcastToColor('[FFFF00]ANSWER:[-] ' .. scriptObject.getVar('answer'), v) end
                end
            end
            scriptObject.setVar('answer', '')
        end
        scriptObject.setVar('countdownActive', false)
        scriptObject.setVar('buzzerLocked', true)
        scriptObject.call('hideBoardLights')
    end)
    return 1   
end