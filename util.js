require('dotenv').config();

module.exports = {
    generatePlayerToken: () => {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let randomString = '';
      
        for (let i = 0; i < 7; i++) {
          const randomIndex = Math.floor(Math.random() * characters.length);
          randomString += characters[randomIndex];
        }
      
        return randomString;
    },
    
    Level: {
        DEBUG: -1,
        INFO: 0,
        WARN: 1,
        ERROR: 2
    },
    
    log: (level, message) => {
        var logLevel = process.env.LOG_LEVEL != undefined ? process.env.LOG_LEVEL : 0;
        var levelText;
    
        if(level < logLevel) return;
    
        switch(level)
        {
            case -1:
                levelText = "\x1b[36mDEBUG";
                break;
            case 0:
                levelText = "INFO";
                break;
            case 1:
                levelText = "\x1b[33mWARN";
                break;
            case 2:
                levelText = "\x1b[31mERROR"
                break;
            default:
                levelText = "UNKNOWN"
                break;
        }
        console.log('\x1b[35m[' + new Date().toISOString() + '][' + levelText + '\x1b[35m] | \x1b[37m' + message)
    }
}