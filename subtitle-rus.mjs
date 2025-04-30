import 'dotenv/config';
import fs from "fs";
import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { SocksProxyAgent } from 'socks-proxy-agent';
import Groq from "groq-sdk";

// Преобразуем exec в функцию, возвращающую промис, для использования с async/await
const execAsync = promisify(exec);

// Создаем агент SOCKS5 прокси, если задана переменная окружения SOCKS5
const proxyAgent = process.env.SOCKS5
    ? new SocksProxyAgent(process.env.SOCKS5)
    : undefined;

// Инициализируем SDK Groq с API-ключом и настройками прокси (если есть)
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    ...(proxyAgent && {
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent
    })
});

async function main() {
    // Проверяем наличие аргумента командной строки для входного файла
    if (process.argv.length < 3) {
        console.error("Ошибка: необходимо указать имя файла");
        console.log("Использование: node subtitle-rus.mjs <имя_файла>");
        process.exit(1);
    }

    const inputFile = process.argv[2];
    // Проверяем, существует ли входной файл
    if (!fs.existsSync(inputFile)) {
        console.error(`Ошибка: файл "${inputFile}" не существует`);
        process.exit(1);
    }

    // Проверяем, установлена ли утилита ffmpeg и доступна ли она
    try {
        await execAsync('ffmpeg -version');
    } catch (error) {
        console.error("Ошибка: утилита ffmpeg не установлена или недоступна");
        process.exit(1);
    }

    // Проверяем, установлена ли утилита trans (translate-shell) и доступна ли она
    try {
        await execAsync('trans --version');
    } catch (error) {
        console.error("Ошибка: утилита trans не установлена или недоступна");
        process.exit(1);
    }

    // Извлекаем директорию, имя файла и расширение из пути входного файла
    const { dir: inputDir, name: fileName, ext } = path.parse(inputFile);

    // Проверяем, существует ли файл субтитров с расширением .srt
    const srtFile = path.join(inputDir, `${fileName}.srt`);
    if (fs.existsSync(srtFile)) {
        console.log(`Субтитры для файла \x1b[33m${inputFile}\x1b[0m уже сгенерированы`);
        process.exit(0);
    }

    console.log(`Создаем субтитры для файла \x1b[33m${inputFile}\x1b[0m`);

    // Определяем путь для временного MP3-файла
    const mp3File = path.join(inputDir, `${fileName}.mp3`);

    // Конвертируем видео в MP3, если MP3-файл еще не существует
    if (!fs.existsSync(mp3File)) {
        // Используем ffmpeg для извлечения аудио из видео и сохранения в формате MP3
        const command = `ffmpeg -i "${inputFile}" -vn -acodec libmp3lame -q:a 2 "${mp3File}"`;
        await execAsync(command);
    }

    let transcription;
    // Транскрибируем аудио с помощью сервиса транскрипции Groq
    try {
        transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(mp3File), // Читаем MP3-файл как поток
            model: "whisper-large-v3", // Используем модель Whisper large v3 для транскрипции
            language: "en", // Предполагаем, что аудио на английском
            response_format: "verbose_json", // Запрашиваем подробный JSON-вывод
        });
    } catch (error) {
        console.error(`Ошибка транскрипции аудио: ${error.message}`);
        // Удаляем временный MP3-файл в случае ошибки
        if (fs.existsSync(mp3File)) fs.unlinkSync(mp3File);
        process.exit(1);
    }

    // Преобразуем сегменты транскрипции в формат субтитров SRT
    const srtContent = convertToSRT(transcription.segments);

    // Сохраняем временный SRT-файл с транскрибированными субтитрами
    const tempSrtFile = path.join(inputDir, `${fileName}_temp.srt`);
    fs.writeFileSync(tempSrtFile, srtContent);

    // Переводим субтитры с английского на русский
    const translatedSrt = await translateSrt(tempSrtFile, 'en:ru');

    // Сохраняем окончательный файл субтитров
    const finalSrtFile = path.join(inputDir, `${fileName}.srt`);
    fs.writeFileSync(finalSrtFile, translatedSrt);

    // Удаляем временные файлы (MP3 и временный SRT)
    fs.unlinkSync(mp3File);
    fs.unlinkSync(tempSrtFile);

    console.log(`Субтитры для файла \x1b[32m${inputFile}\x1b[0m созданы\n`);
}

async function translateSrt(srtFilePath, translationDirection) {
    // Запоминаем время начала для расчета длительности перевода
    const startTime = Date.now();
    // Разделяем направление перевода на исходный и целевой языки (например, 'en:ru' -> ['en', 'ru'])
    const [fromLang, toLang] = translationDirection.split(':');

    console.log(`Файл \x1b[1;33m${srtFilePath}\x1b[0m`);
    console.log(`Направление перевода: \x1b[1;36m${fromLang} → ${toLang}\x1b[0m`);

    try {
        // Читаем содержимое исходного SRT-файла
        const original = fs.readFileSync(srtFilePath, 'utf8');

        // Разделяем содержимое SRT на отдельные строки
        const arrayOriginStrings = original.split(/\r?\n/);

        // Сопоставляем каждой строке её индекс для отслеживания
        const numberedLines = arrayOriginStrings.map((line, index) => [index, line]);

        // Фильтруем строки, содержащие текст субтитров (исключаем номера и временные метки)
        const arrayForTranslate = numberedLines.filter(([index, line]) => {
            const trimmedLine = line.trim();
            return trimmedLine &&
                !/^\d+$/.test(trimmedLine) && // Не номер субтитра
                !/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(trimmedLine); // Не временная метка
        });

        // Функция для перевода одной строки текста с помощью команды trans
        async function translateText(text) {
            try {
                // Экранируем двойные кавычки в тексте для безопасного выполнения команды
                const escapedText = text.replace(/"/g, '\\"');
                // Формируем команду перевода с указанием исходного и целевого языков
                const command = `trans -brief -no-warn -from ${fromLang} -to ${toLang} "${escapedText}"`;
                const { stdout, stderr } = await execAsync(command);
                if (stderr) {
                    console.error(`Ошибка перевода: ${stderr}`);
                    return text; // Возвращаем исходный текст в случае ошибки
                }
                return stdout.trim(); // Возвращаем переведенный текст
            } catch (error) {
                console.error(`Ошибка перевода текста: ${text}`, error.message);
                return text; // Возвращаем исходный текст в случае ошибки
            }
        }

        // Переводим все строки субтитров параллельно
        const translationPromises = arrayForTranslate.map(async ([index, line]) => {
            const translated = await translateText(line);
            return { index, translated };
        });

        // Ожидаем завершения всех переводов
        const translationResults = await Promise.all(translationPromises);

        // Обновляем исходные строки переведенным текстом
        translationResults.forEach(({ index, translated }) => {
            numberedLines[index][1] = translated;
        });

        // Формируем содержимое SRT-файла из обновленных строк
        const arrayTransated = numberedLines.map(([index, line]) => line);
        const translatedText = arrayTransated.join('\n');

        // Рассчитываем и форматируем длительность перевода
        const endTime = Date.now();
        const durationInSeconds = Math.round((endTime - startTime) / 1000);
        let durationString = durationInSeconds < 60
            ? `${durationInSeconds} сек`
            : `${Math.floor(durationInSeconds / 60)} мин ${durationInSeconds % 60} сек`;

        // Очищаем предыдущие строки консоли и выводим статус завершения перевода
        process.stdout.write('\x1B[2A\x1B[2K');
        console.log(`\x1b[1;32mПереведен за ${durationString}\x1b[0m`);

        return translatedText; // Возвращаем переведенное содержимое SRT
    } catch (error) {
        // Очищаем предыдущие строки консоли и выводим статус ошибки
        process.stdout.write('\x1B[2A\x1B[2K');
        console.log(`\x1b[1;31mНе удалось перевести\x1b[0m`);
        console.error('Ошибка:', error.message);
        throw error;
    }
}

function convertToSRT(data) {
    const result_srt = [];

    // Перебираем сегменты транскрипции для создания записей SRT
    for (let i = 0; i < data.length; i++) {
        const iter = [];
        // Добавляем номер субтитра (индекс, начиная с 1)
        iter.push(data[i].id + 1);
        iter.push('\n');
        // Добавляем отформатированное время начала
        iter.push(formatTime(data[i].start));
        iter.push(' ');
        iter.push('-->');
        iter.push(' ');
        // Добавляем отформатированное время окончания
        iter.push(formatTime(data[i].end));
        iter.push('\n');
        // Добавляем текст субтитра
        iter.push(data[i].text.trim());
        iter.push('\n');
        iter.push('\n');
        // Объединяем компоненты и добавляем в результат
        result_srt.push(iter.join(''));
    }

    // Объединяем все записи SRT в одну строку
    return result_srt.join('');
}

function formatTime(secondsWithMs) {
    // Преобразуем секунды с миллисекундами в целые секунды и миллисекунды
    const totalSeconds = Math.floor(secondsWithMs);
    const milliseconds = Math.round((secondsWithMs - totalSeconds) * 1000);

    // Вычисляем часы, минуты и секунды
    const hours = Math.floor(totalSeconds / 3600);
    const remainingSeconds = totalSeconds % 3600;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;

    // Дополняем числа ведущими нулями для единообразного формата
    const pad = (num, size) => num.toString().padStart(size, '0');

    // Форматируем время в формате ЧЧ:ММ:СС,ммм
    const hoursStr = pad(hours, 2);
    const minutesStr = pad(minutes, 2);
    const secondsStr = pad(seconds, 2);
    const msStr = pad(milliseconds, 3);

    return `${hoursStr}:${minutesStr}:${secondsStr},${msStr}`;
}

// Запускаем основную функцию и обрабатываем любые необработанные ошибки
main().catch(console.error);