require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');

// Перевірка наявності LOG_DIR
if (!process.env.LOG_DIR) {
    console.error('❌ LOG_DIR не задано в .env');
    process.exit(1);
}

// Енум для рівнів логування
const LogLevels = {
    Info: 'INFO',
    Warning: 'WARNING',
    Error: 'ERROR',
    Debug: 'DEBUG',
    Success: 'SUCCESS',
    Important: 'IMPORTANT'
};

class Logger {
    constructor() {
        this.logDirectory = path.join(__dirname, process.env.LOG_DIR);
        this.logQueue = [];
        this.isProcessing = false;

        this.ensureLogDirectory();
        this.ensureTodayLogFile();
        this.processQueue();
        this.log('Logger initialized', LogLevels.Info);
    }

    async ensureLogDirectory() {
        try {
            await fs.mkdir(this.logDirectory, { recursive: true });
        } catch (error) {
            this.printToConsole(LogLevels.Error, `[${new Date().toISOString()}] [Error] Не вдалося створити теку логів: ${error.message}`);
        }
    }

    async ensureTodayLogFile() {
        const todayFilePath = this.getLogFilePath(new Date());
        try {
            await fs.access(todayFilePath);
        } catch (error) {
            try {
                await fs.writeFile(todayFilePath, '');
                this.printToConsole(LogLevels.Info, `[${new Date().toISOString()}] [Info] Створено новий файл логів: ${todayFilePath}`);
            } catch (writeError) {
                this.printToConsole(LogLevels.Error, `[${new Date().toISOString()}] [Error] Не вдалося створити файл логів: ${writeError.message}`);
            }
        }
    }

    log(message, level = LogLevels.Info, source = 'Logger') {
        const timestamp = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
        const logEntry = `[${timestamp}] [${level}] ${message} (Source: ${source})`;
        this.logQueue.push({ timestamp, level, message: logEntry });
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.logQueue.length > 0) {
            const { timestamp, level, message } = this.logQueue.shift();
            this.printToConsole(level, message);
            await this.logToFile(timestamp, level, message);
        }

        this.isProcessing = false;
    }

    printToConsole(level, message) {
        switch (level) {
            case LogLevels.Warning:
                console.log(chalk.yellow(message));
                break;
            case LogLevels.Important:
                console.log(chalk.cyan(message));
                break;
            case LogLevels.Error:
                console.log(chalk.red(message));
                break;
            case LogLevels.Debug:
                console.log(chalk.magenta(message));
                break;
            case LogLevels.Success:
                console.log(chalk.green(message));
                break;
            case LogLevels.Info:
                console.log(chalk.blue(message));
                break;
            default:
                console.log(message);
        }
    }

    async logToFile(timestamp, level, message) {
        try {
            const filePath = this.getLogFilePath(timestamp);
            try {
                await fs.access(filePath);
            } catch (error) {
                await fs.writeFile(filePath, '');
                this.printToConsole(LogLevels.Info, `[${new Date().toISOString()}] [Info] Створено новий файл логів: ${filePath}`);
            }
            await fs.appendFile(filePath, message + '\n');
        } catch (error) {
            this.printToConsole(LogLevels.Error, `[${new Date().toISOString()}] [Error] Failed to write to file: ${error.message}`);
        }
    }

    getLogFilePath(timestamp) {
        const date = new Date(timestamp).toISOString().split('T')[0];
        return path.join(this.logDirectory, `${date}.log`);
    }
}

// Експорт логера та LogLevels
module.exports = { Logger: new Logger(), LogLevels };