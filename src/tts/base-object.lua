-- Jeopardy script object
scriptObject = getObjectFromGUID('a94ab1')

function onLoad()
    if scriptObject == nil then
        printToAll('This object must be spawned in a Jeopardy game. Please read the docs for more information.')
        return
    end

    -- Request the LUA for this object
    WebRequest.get("https://raw.githubusercontent.com/Ryan6578/tts-jeopardy-buzzer/main/src/tts/object.lua", function(luaRequest)
        if luaRequest.is_error then
            log(request.error)
            printToAll('An error occurred while trying to get the LUA for the Jeopardy web buzzer object from GitHub! Check the logs tab for more information.')
        else
            -- Set the LUA accordingly
            self.setLuaScript(luaRequest.text)

            log('Latest LUA successfully retrieved and set from GitHub.')

            -- Reload this object with the updated XML and LUA
            self.reload()

            log('Jeopardy web buzzer object reloaded with latest updates from GitHub.')
        end
    end)
end