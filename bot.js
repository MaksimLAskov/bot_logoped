const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Конфигурация
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';
const ADMIN_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// Инициализация бота
const bot = new TelegramBot(TOKEN, {polling: true});
const pendingQuestions = {};

// Проверка и создание папки для логов
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

// Функция логирования
function logEvent(type, data) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        type,
        ...data
    };
    
    fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
    console.log(`[${timestamp}] ${type}:`, JSON.stringify(data, null, 2));
}

// Проверка прав бота
bot.getMe().then(botInfo => {
    logEvent('BOT_STARTED', {
        username: botInfo.username,
        id: botInfo.id
    });
});

// Обработка команды /start
bot.onText(/\/start/, (msg) => {
    logEvent('COMMAND_START', {
        userId: msg.from.id,
        chatId: msg.chat.id,
        userName: msg.from.first_name
    });

    bot.sendMessage(msg.chat.id, `${msg.from.first_name}! Вас приветствует учитель-логопед Архипова Надежда Михайловна. Рада приветствовать вас в своем телеграмм боте "Вопрос-ответ". Здесь вы можете анонимно уточнить у меня вопросы, связанные с логопедическими проблемами и получить ответ в течении 30 минут! `, {
        reply_markup: {
            keyboard: [[{text: 'Задать вопрос'}]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    }).then(sentMsg => {
        logEvent('BOT_REPLY', {
            type: 'welcome_message',
            messageId: sentMsg.message_id,
            chatId: sentMsg.chat.id
        });
    });
});

// Обработка входящих сообщений
bot.on('message', (msg) => {
    // Логируем все сообщения
    logEvent('INCOMING_MESSAGE', {
        messageId: msg.message_id,
        chatId: msg.chat.id,
        userId: msg.from.id,
        text: msg.text,
        isAdmin: msg.chat.id.toString() === ADMIN_ID.toString()
    });

    // Игнорируем команды и сообщения от админа (кроме ответов)
    if (msg.text?.startsWith('/') || 
       (msg.chat.id.toString() === ADMIN_ID.toString() && !msg.reply_to_message)) {
        return;
    }

    // Обработка вопросов от пользователей
    if (msg.chat.id.toString() !== ADMIN_ID.toString()) {
        handleUserQuestion(msg);
    }
    
    // Обработка ответов от админа
    if (msg.chat.id.toString() === ADMIN_ID.toString() && msg.reply_to_message) {
        handleAdminReply(msg);
    }
});

// Обработка callback-запросов
bot.on('callback_query', (callbackQuery) => {
    logEvent('CALLBACK_QUERY', {
        data: callbackQuery.data,
        from: callbackQuery.from.id,
        message: callbackQuery.message
    });

    if (callbackQuery.data.startsWith('reply_')) {
        const [_, userChatId, userMessageId] = callbackQuery.data.split('_');
        
        bot.sendMessage(ADMIN_ID, `Отправьте ответ на вопрос пользователя (ID: ${userChatId}):`, {
            reply_to_message_id: callbackQuery.message.message_id
        }).then(sentMsg => {
            logEvent('ADMIN_REPLY_PROMPT', {
                adminMessageId: sentMsg.message_id,
                userChatId,
                userMessageId
            });
        });
        
        pendingQuestions[userChatId] = userMessageId;
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

// Функция обработки вопроса пользователя
function handleUserQuestion(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === 'Задать вопрос') {
        bot.sendMessage(chatId, 'Пожалуйста, напишите ваш вопрос:').then(sentMsg => {
            logEvent('BOT_REPLY', {
                type: 'question_prompt',
                messageId: sentMsg.message_id,
                chatId
            });
        });
    } else {
        const questionText = `Пользователь ${msg.from.first_name} (ID: ${chatId}) задал вопрос:\n\n${text}`;
        
        bot.sendMessage(ADMIN_ID, questionText, {
            reply_markup: {
                inline_keyboard: [[
                    { 
                        text: 'Ответить', 
                        callback_data: `reply_${chatId}_${msg.message_id}`
                    }
                ]]
            }
        }).then(sentMsg => {
            logEvent('QUESTION_FORWARDED', {
                adminMessageId: sentMsg.message_id,
                userMessageId: msg.message_id,
                userChatId: chatId
            });
        });
        
        pendingQuestions[chatId] = msg.message_id;
        
        bot.sendMessage(chatId, 'Ваш вопрос был отправлен администратору. Ожидайте ответа.')
            .then(sentMsg => {
                logEvent('BOT_REPLY', {
                    type: 'question_received',
                    messageId: sentMsg.message_id,
                    chatId
                });
            });
    }
}

// Функция обработки ответа админа
function handleAdminReply(msg) {
    const replyMsg = msg.reply_to_message;
    let userChatId = null;

    logEvent('ADMIN_REPLY_ATTEMPT', {
        adminMessageId: msg.message_id,
        replyToMessageId: replyMsg.message_id,
        replyText: replyMsg.text
    });

    // Поиск ID пользователя в разных форматах
    const idMatch = replyMsg.text?.match(/ID: (\d+)/);
    if (idMatch) {
        userChatId = idMatch[1];
    } else if (replyMsg.reply_markup) {
        const inlineKeyboard = replyMsg.reply_markup.inline_keyboard;
        for (const row of inlineKeyboard) {
            for (const button of row) {
                if (button.callback_data?.startsWith('reply_')) {
                    userChatId = button.callback_data.split('_')[1];
                    break;
                }
            }
            if (userChatId) break;
        }
    }

    if (!userChatId) {
        logEvent('USER_ID_NOT_FOUND', {
            adminMessageId: msg.message_id,
            replyText: replyMsg.text
        });
        return bot.sendMessage(ADMIN_ID, '❌ Не удалось определить ID пользователя. Ответьте непосредственно на сообщение с вопросом.');
    }

    const answerText = `Ответ администратора:\n\n${msg.text}`;
    
    bot.sendMessage(userChatId, answerText)
        .then(sentMsg => {
            logEvent('ANSWER_DELIVERED', {
                userMessageId: sentMsg.message_id,
                userChatId,
                adminMessageId: msg.message_id
            });
            
            delete pendingQuestions[userChatId];
        })
        .catch(error => {
            logEvent('DELIVERY_ERROR', {
                error: error.message,
                userChatId,
                adminMessageId: msg.message_id
            });
            
            bot.sendMessage(ADMIN_ID, `❌ Ошибка доставки ответа пользователю (ID: ${userChatId}): ${error.message}`);
        });
}

console.log(`Бот запущен. Логи записываются в ${LOG_FILE}`);
