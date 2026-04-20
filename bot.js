require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('Missing BOT_TOKEN or CHAT_ID in .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const MIN_MS = 60 * 1000;

// Register commands so the "/" button in Telegram shows them
bot.setMyCommands([
  { command: 'nastroy', description: 'Начать ритуал настройки' },
  { command: 'stop',    description: 'Завершить рабочую сессию досрочно' },
  { command: 'stats',   description: 'Ваша статистика глубокой работы' },
  { command: 'framing', description: 'Изменить духовный / секулярный формат' },
  { command: 'cancel',  description: 'Отменить текущую настройку' },
]).catch(e => console.error('Failed to set commands:', e.message));

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PROFILES_FILE = './user_profiles.json';
const SESSION_LOG_FILE = './session_log.json';
const SEEN_USERS_FILE = './seen_users.json';

function loadSeenUsers() {
  try {
    if (fs.existsSync(SEEN_USERS_FILE)) return JSON.parse(fs.readFileSync(SEEN_USERS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load seen users:', e.message); }
  return [];
}

function markUserSeen(userId) {
  if (seenUsers.includes(userId)) return;
  seenUsers.push(userId);
  try { fs.writeFileSync(SEEN_USERS_FILE, JSON.stringify(seenUsers)); } catch (e) { console.error(e.message); }
}

let seenUsers = loadSeenUsers();

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error(`Failed to load ${file}:`, e.message); }
  return {};
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`Failed to save ${file}:`, e.message); }
}

// { userId: { framing, totalSessions, totalDeepMs, completedCycles } }
let userProfiles = loadJSON(PROFILES_FILE);
// { sessionId: { all fields } }
let sessionLog = loadJSON(SESSION_LOG_FILE);

function getProfile(userId) {
  if (!userProfiles[userId]) {
    userProfiles[userId] = { framing: null, totalSessions: 0, totalDeepMs: 0, completedCycles: 0 };
  }
  return userProfiles[userId];
}
function saveProfiles() { saveJSON(PROFILES_FILE, userProfiles); }
function saveSessions() { saveJSON(SESSION_LOG_FILE, sessionLog); }

// ---------------------------------------------------------------------------
// In-memory FSM — one entry per chatId (private) or userId (group → DM)
// ---------------------------------------------------------------------------

// nastroySessions: Map<chatId(string), NastroyState>
const nastroySessions = new Map();

function makeNastroy(userId, userName) {
  return {
    userId,
    userName,
    state: 'idle',
    version: null,          // 'full' | 'short'
    framing: null,          // 'spiritual' | 'secular'
    // Step 0
    date: todayLabel(),
    location: null,
    project: null,
    // Step 1
    dedication: null,
    // Step 2
    bodyPractice: null,
    bodyDurationMin: null,
    // Step 3
    spaceChecklist: [false, false, false, false, false],
    // Step 4
    durationMin: null,
    // Step 5
    mentalSet: null,
    // Step 6
    goal: null,
    // Session
    startedAt: null,
    endedAt: null,
    pinnedMessageId: null,
    sessionTimeout: null,
    goalAchieved: null,     // 'full' | 'partial' | 'continues'
    nextStep: null,
    reflection: null,
    gratitudeText: null,
    // Tracking which steps were skipped (for future analytics)
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayLabel() {
  return new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtMin(n) {
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  const lastOne = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 19) return `${n} минут`;
  if (lastOne === 1) return `${n} минута`;
  if (lastOne >= 2 && lastOne <= 4) return `${n} минуты`;
  return `${n} минут`;
}

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return fmtMin(m);
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

async function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}

// ---------------------------------------------------------------------------
// Space checklist
// ---------------------------------------------------------------------------

const SPACE_ITEMS = [
  'Убрал лишнее со стола',
  'Телефон — в режиме «не беспокоить»',
  'Закрыл лишние вкладки / приложения',
  'Подготовил инструменты (документ открыт)',
  'Вода / чай рядом',
];

function spaceChecklistKeyboard(checklist) {
  const rows = SPACE_ITEMS.map((label, i) => [{
    text: `${checklist[i] ? '✅' : '☐'} ${label}`,
    callback_data: `ns:s3toggle:${i}`,
  }]);
  rows.push([{ text: 'Пространство готово →', callback_data: 'ns:s3done' }]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Body practices
// ---------------------------------------------------------------------------

const BODY_PRACTICES = [
  { key: 'walk',      label: '🚶 Пройтись / подышать у окна', durationMin: 3 },
  { key: 'squats',    label: '🏃 25 приседаний',              durationMin: 2 },
  { key: 'relax',     label: '🧘 Прогрессивная релаксация',   durationMin: 2 },
  { key: 'breathing', label: '🌬 Дыхание 4-7-8 (4 цикла)',    durationMin: 2 },
  { key: 'custom',    label: '✋ Своя практика',              durationMin: null },
];

const BODY_GUIDANCE = {
  walk:
    `🚶 *Прогулка и дыхание*\n\n` +
    `Встаньте, откройте окно или выйдите на балкон. Дышите медленно — вдох носом, выдох ртом. ` +
    `Пройдитесь несколько минут без телефона.\n\n` +
    `Когда почувствуете, что тело «ожило» — возвращайтесь.`,
  squats:
    `🏃 *25 приседаний*\n\n` +
    `Медленные, до параллели с полом. Не торопитесь — это не фитнес, а разгон крови к мозгу.\n\n` +
    `25 раз. Дышите ровно.`,
  relax:
    `🧘 *Прогрессивная релаксация*\n\n` +
    `Сядьте удобно. Последовательно напрягайте и отпускайте:\n\n` +
    `1. Ступни и голени — напрягите 5 сек → отпустите\n` +
    `2. Бёдра и живот — 5 сек → отпустите\n` +
    `3. Руки и плечи — 5 сек → отпустите\n` +
    `4. Лицо и шея — 5 сек → отпустите\n\n` +
    `Глубокий вдох и медленный выдох. Повторите дважды.`,
  breathing:
    `🌬 *Дыхание 4-7-8*\n\n` +
    `Четыре цикла:\n\n` +
    `• Вдох носом — *4 секунды*\n` +
    `• Задержка — *7 секунд*\n` +
    `• Выдох ртом — *8 секунд*\n\n` +
    `Это переключает нервную систему в режим сосредоточенного покоя.`,
};

// ---------------------------------------------------------------------------
// Step renderers
// ---------------------------------------------------------------------------

async function showIntro(chatId, ns) {
  ns.state = 'intro';
  await send(chatId,
    `Этот бот сделан на основе статьи:\n\n` +
    `Шаньков, Ф. М. (2020). Психотехника Ф.Е. Василюка: настройка на сложную деятельность.`
  ).catch(() => {});
  await send(chatId,
    `🕯 *Режим НАСТРОЙ*\n\n` +
    `Фёдор Ефимович Василюк — российский психолог, основатель первого в России факультета психологического консультирования, автор фундаментальных трудов по психологии переживания. ` +
    `Несмотря на огромную научную, преподавательскую и терапевтическую нагрузку, он оставался удивительно продуктивным — ` +
    `и одной из опор этой продуктивности была короткая психотехника «настройки» перед каждым сложным делом, ` +
    `которую он записывал в обычных школьных тетрадях.\n\n` +
    `Сейчас мы пройдём её вместе за 7 шагов. Это займёт 3–5 минут и подготовит вас к по-настоящему сосредоточенной работе.\n\n` +
    `_Готовы начать?_`,
    { reply_markup: { inline_keyboard: [[
      { text: 'Да, начнём', callback_data: 'ns:start:yes' },
      { text: 'В другой раз',  callback_data: 'ns:start:no'  },
    ]] } }
  );
}

async function showVersionSelect(chatId, ns) {
  ns.state = 'version_select';
  await send(chatId,
    `Выберите формат:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '📖 Полная версия (~5–7 мин, все 7 шагов)',      callback_data: 'ns:version:full'  }],
      [{ text: '⚡ Краткая версия (~2 мин, когда времени мало)', callback_data: 'ns:version:short' }],
    ] } }
  );
}

async function showFramingSelect(chatId, ns) {
  ns.state = 'framing_select';
  await send(chatId,
    `Один вопрос — только один раз. Ваш ответ сохранится, больше спрашивать не буду.\n\n` +
    `Шаг 1 и финальная благодарность существуют в двух вариантах:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '✝️ Духовный (молитвенное обращение)', callback_data: 'ns:framing:spiritual' }],
      [{ text: '🧭 Секулярный (ценности и посвящение)', callback_data: 'ns:framing:secular'  }],
    ] } }
  );
}

async function showStep0Location(chatId, ns) {
  ns.state = 'header_location';
  await send(chatId,
    `*Шаг 0. Заголовок*\n\n` +
    `Василюк всегда начинал с того, что записывал вверху страницы дату, место и название проекта. ` +
    `Это якорь — «здесь и сейчас я занимаюсь вот этим».\n\n` +
    `📅 Дата: *${ns.date}*\n\n` +
    `📍 Где вы сейчас находитесь?\n_(например: дом, кабинет, библиотека, кафе)_`
  );
}

async function showStep0Project(chatId, ns) {
  ns.state = 'header_project';
  await send(chatId, `📂 Название проекта или задачи?`);
}

async function showStep1(chatId, ns) {
  ns.state = 'step1';
  if (ns.framing === 'spiritual') {
    await send(chatId,
      `*Шаг 1. † Молитвенное обращение*\n\n` +
      `Василюк, как И.С. Бах, подписывавший партитуры «Единому Богу слава», посвящал каждое дело духовному измерению — ` +
      `обращаясь за помощью, соавторством, благословением.\n\n` +
      `Произнесите краткую молитву или посвящение про себя. Когда закончите — нажмите «Готово».`,
      { reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: 'ns:s1done' }]] } }
    );
  } else {
    await send(chatId,
      `*Шаг 1. Посвящение и ценность*\n\n` +
      `Василюк описывал это как «подключение к энергии надиндивидуальной сущности, с которой связан индивид своими ценностями» — ` +
      `обращение к тому, что больше тебя самого.\n\n` +
      `Кому или чему вы посвящаете эту работу? Какой большей ценности она служит?\n` +
      `_(Например: будущим студентам, науке, семье, своему призванию)_`
    );
  }
}

async function showStep1Short(chatId, ns) {
  ns.state = 'step1';
  if (ns.framing === 'spiritual') {
    await send(chatId,
      `*Шаг 1. † Обращение*\n\nПроизнесите краткое посвящение про себя.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: 'ns:s1done' }]] } }
    );
  } else {
    await send(chatId,
      `*Шаг 1. Посвящение*\n\nКому или чему эта работа? Одним словом или фразой.`
    );
  }
}

async function showStep2Choice(chatId, ns) {
  ns.state = 'step2_choice';
  await send(chatId,
    `*Шаг 2. Ф — Физиология*\n\n` +
    `Перед работой Фёдор Ефимович мог выйти на прогулку, 25 раз присесть, чтобы «разогнать кровь», ` +
    `сделать ауторелаксацию или цигун. Мысль не работает на застоявшемся теле.\n\n` +
    `Выберите короткую телесную практику (1–3 минуты):`,
    { reply_markup: { inline_keyboard: BODY_PRACTICES.map(p => [{ text: p.label, callback_data: `ns:s2:${p.key}` }]) } }
  );
}

async function showStep2Short(chatId, ns) {
  ns.state = 'step2_timer';
  ns.bodyPractice = 'breathing';
  ns.bodyDurationMin = 1;
  await send(chatId,
    `*Шаг 2. Три вдоха*\n\nМедленный вдох носом — задержка — выдох ртом. Три раза.\n\nГотово?`,
    { reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: 'ns:s2done' }]] } }
  );
}

async function showStep2CustomDuration(chatId, ns) {
  ns.state = 'step2_custom_duration';
  await send(chatId, `Сколько минут займёт ваша практика? _(введите число)_`);
}

async function showStep2Guidance(chatId, ns, practiceKey) {
  ns.state = 'step2_timer';
  const guidance = BODY_GUIDANCE[practiceKey] || `✋ *Ваша практика*\n\nПриступайте.`;
  await send(chatId,
    guidance + `\n\n_Нажмите «Готово», когда закончите._`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Готово, я вернулся', callback_data: 'ns:s2done' }]] } }
  );
}

async function showStep3(chatId, ns) {
  ns.state = 'step3';
  await send(chatId,
    `*Шаг 3. Л — Пространство*\n\n` +
    `«Выделение главного, отсечение лишнего.» Подготовьте рабочее место.\n\n` +
    `Отметьте, что вы сделали:`,
    { reply_markup: spaceChecklistKeyboard(ns.spaceChecklist) }
  );
}

async function showStep3Short(chatId, ns) {
  ns.state = 'step3';
  ns.spaceChecklist = [false, false, false, false, false]; // reset
  await send(chatId,
    `*Шаг 3. Л — Пространство*\n\nОдно главное: уберите телефон в режим «не беспокоить».`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Сделано', callback_data: 'ns:s3done' }]] } }
  );
}

async function showStep4(chatId, ns) {
  ns.state = 'step4';
  await send(chatId,
    `*Шаг 4. t — Время*\n\n` +
    `«Сколько времени можно и нужно в реальности посвятить этому делу?» ` +
    `Василюк проделывал настройку даже когда на задачу было 15 минут.\n\n` +
    `Сколько времени у вас есть сейчас?`,
    { reply_markup: { inline_keyboard: [
      [
        { text: '15 мин', callback_data: 'ns:s4:15' },
        { text: '25 мин', callback_data: 'ns:s4:25' },
        { text: '50 мин', callback_data: 'ns:s4:50' },
        { text: '90 мин', callback_data: 'ns:s4:90' },
      ],
      [{ text: '✏️ Свой вариант', callback_data: 'ns:s4:custom' }],
    ] } }
  );
}

async function showStep5(chatId, ns) {
  ns.state = 'step5';
  await send(chatId,
    `*Шаг 5. Ψ — Психологическая установка*\n\n` +
    `Какой внутренний настрой вы хотите удержать сегодня, противостоя отвлечениям и внешнему шуму?\n\n` +
    `Сформулируйте одной фразой.\n` +
    `_(Примеры: «спокойная сосредоточенность», «писать смело, редактировать потом», «без перфекционизма»)_`
  );
}

async function showStep5Short(chatId, ns) {
  ns.state = 'step5';
  await send(chatId,
    `*Шаг 5. Установка*\n\nОдна фраза — ваш внутренний настрой на эту сессию.`
  );
}

const VAGUE_VERBS = ['поработать', 'подумать', 'посмотреть', 'поделать', 'позаниматься', 'попробовать', 'немного'];

async function showStep6(chatId, ns) {
  ns.state = 'step6';
  await send(chatId,
    `*Шаг 6. Ц — Цель*\n\n` +
    `«Осознаваемый образ предвосхищаемого результата.» Чёткая формулировка реалистичной цели — половина её достижения.\n\n` +
    `Что конкретно будет готово к концу этой сессии? Сформулируйте измеримо.\n\n` +
    `_Плохо:_ «поработать над статьёй»\n` +
    `_Хорошо:_ «написать черновик раздела "Методы", ~400 слов»`
  );
}

async function showStep6Short(chatId, ns) {
  ns.state = 'step6';
  await send(chatId,
    `*Шаг 6. Цель*\n\nЧто конкретно будет готово к концу сессии? Сформулируйте измеримо.`
  );
}

async function showTransition(chatId, ns) {
  ns.state = 'pre_session';
  await send(chatId,
    `✨ *Настройка завершена.*\n\n` +
    `📍 ${ns.project} · ${ns.location} · ${ns.date}\n` +
    `🎯 Цель: _${ns.goal}_\n` +
    `🧭 Установка: _${ns.mentalSet}_\n` +
    `⏱ Время: ${fmtMin(ns.durationMin)}\n\n` +
    `Нажмите «Старт» — и работайте глубоко.`,
    { reply_markup: { inline_keyboard: [[{ text: '▶️ Старт сессии', callback_data: 'ns:session:start' }]] } }
  );
}

async function startSession(chatId, ns) {
  ns.state = 'session_active';
  ns.startedAt = Date.now();

  const pinMsg = await send(chatId,
    `🧭 *Установка:* _${ns.mentalSet}_\n\n⏱ Работаем ${fmtMin(ns.durationMin)}. Глубокой работы.`
  );
  ns.pinnedMessageId = pinMsg.message_id;
  try { await bot.pinChatMessage(chatId, pinMsg.message_id, { disable_notification: true }); } catch (_) {}

  ns.sessionTimeout = setTimeout(() => endSession(chatId, ns), ns.durationMin * MIN_MS);
}

async function endSession(chatId, ns) {
  ns.endedAt = Date.now();
  if (ns.pinnedMessageId) {
    try { await bot.unpinAllChatMessages(chatId); } catch (e) { console.error('Failed to unpin:', e.message); }
    ns.pinnedMessageId = null;
  }
  await showStep7Reflection(chatId, ns);
}

async function showStep7Reflection(chatId, ns) {
  ns.state = 'step7_reflection';
  await send(chatId,
    `🕯 *Завершение. Рефлексия и благодарность.*\n\n` +
    `Время вышло. Сделайте несколько вдохов.\n\n` +
    `*1. Что получилось сделать?*\n_(1–2 фразы, свободно)_`
  );
}

async function showStep7Goal(chatId, ns) {
  ns.state = 'step7_goal';
  await send(chatId,
    `*2. Достигнута ли цель — «${ns.goal}»?*`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Полностью',                callback_data: 'ns:s7goal:full'      },
      { text: '🟡 Частично',                callback_data: 'ns:s7goal:partial'   },
      { text: '⏳ Продолжу в следующий раз', callback_data: 'ns:s7goal:continues' },
    ]] } }
  );
}

async function showStep7Next(chatId, ns) {
  ns.state = 'step7_next';
  await send(chatId,
    `*3. Что остаётся на следующий раз?*\n_(первая фраза или шаг — ваш «shutdown complete»)_`
  );
}

async function showStep7Gratitude(chatId, ns) {
  ns.state = 'step7_gratitude';
  if (ns.framing === 'spiritual') {
    await send(chatId,
      `*4. † Благодарность*\n\nПроизнесите краткую благодарственную молитву.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: 'ns:s7gratitude:done' }]] } }
    );
  } else {
    await send(chatId,
      `*4. Благодарность*\n\n` +
      `Поблагодарите себя, этот отрезок времени, или того, кому вы посвящали работу в начале. ` +
      `Одной фразой — вслух или про себя.\n\n_(Можно написать здесь, или просто нажать «Готово»)_`,
      { reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: 'ns:s7gratitude:done' }]] } }
    );
  }
}

async function finishNastroy(chatId, ns) {
  // Save to session log
  const sessionId = `${ns.userId}_${ns.startedAt || Date.now()}`;
  sessionLog[sessionId] = {
    userId:           ns.userId,
    userName:         ns.userName,
    date:             ns.date,
    location:         ns.location,
    project:          ns.project,
    dedication:       ns.dedication,
    bodyPractice:     ns.bodyPractice,
    bodyDurationMin:  ns.bodyDurationMin,
    spaceChecklist:   ns.spaceChecklist,
    durationPlanned:  ns.durationMin,
    mentalSet:        ns.mentalSet,
    goal:             ns.goal,
    startedAt:        ns.startedAt,
    endedAt:          ns.endedAt,
    reflection:       ns.reflection,
    goalAchieved:     ns.goalAchieved,
    nextStep:         ns.nextStep,
    gratitudeText:    ns.gratitudeText,
    gratitudeCompleted: true,
    skipped:          ns.skipped,
  };
  saveSessions();

  // Update profile
  const profile = getProfile(ns.userId);
  profile.totalSessions  = (profile.totalSessions  || 0) + 1;
  profile.completedCycles = (profile.completedCycles || 0) + 1;
  if (ns.startedAt && ns.endedAt) {
    profile.totalDeepMs = (profile.totalDeepMs || 0) + (ns.endedAt - ns.startedAt);
  }
  saveProfiles();

  await send(chatId,
    `✨ *Сессия завершена.*\n\n` +
    `Отличная работа. Каждая настроенная сессия — вклад в практику глубокой работы.\n\n` +
    `_До следующего раза._ 🕯`
  );

  nastroySessions.delete(String(chatId));
}

// ---------------------------------------------------------------------------
// Step sequencer — advance to next step based on version
// ---------------------------------------------------------------------------

async function advanceFrom(chatId, ns, completedStep) {
  const full = ns.version === 'full';

  switch (completedStep) {
    case 'intro':         return showVersionSelect(chatId, ns);
    case 'version':
      if (!ns.framing) return showFramingSelect(chatId, ns);
      return showStep0Location(chatId, ns);
    case 'framing':       return showStep0Location(chatId, ns);
    case 'header_location': return showStep0Project(chatId, ns);
    case 'header_project':
      if (full) return showStep1(chatId, ns);
      return showStep1Short(chatId, ns);
    case 'step1':
      if (full) return showStep2Choice(chatId, ns);
      return showStep2Short(chatId, ns);
    case 'step2':
      if (full) return showStep3(chatId, ns);
      return showStep3Short(chatId, ns);
    case 'step3':         return showStep4(chatId, ns);
    case 'step4':
      if (full) return showStep5(chatId, ns);
      return showStep5Short(chatId, ns);
    case 'step5':
      if (full) return showStep6(chatId, ns);
      return showStep6Short(chatId, ns);
    case 'step6':         return showTransition(chatId, ns);
    case 'pre_session':   return startSession(chatId, ns);
    case 'step7_reflection': return showStep7Goal(chatId, ns);
    case 'step7_goal':    return showStep7Next(chatId, ns);
    case 'step7_next':    return showStep7Gratitude(chatId, ns);
    case 'step7_gratitude': return finishNastroy(chatId, ns);
  }
}

// ---------------------------------------------------------------------------
// /start and /nastroy commands
// ---------------------------------------------------------------------------

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = chatId.toString() === CHAT_ID;
  const isPrivate = msg.chat.type === 'private';
  if (!isGroup && !isPrivate) return;

  if (isGroup) {
    // Nudge to DM
    await send(CHAT_ID,
      `🕯 Режим НАСТРОЙ доступен в личных сообщениях — напишите мне напрямую и наберите /nastroy.`
    ).catch(() => {});
    return;
  }

  // Private: welcome
  await send(chatId,
    `🕯 *Writeous НАСТРОЙ*\n\n` +
    `Это бот для настройки к глубокой работе по психотехнике Фёдора Василюка.\n\n` +
    `Команды:\n` +
    `/nastroy — начать ритуал настройки\n` +
    `/stats — ваша статистика глубокой работы\n` +
    `/framing — изменить духовный / секулярный формат`
  );
});

bot.onText(/\/nastroy/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = chatId.toString() === CHAT_ID;
  const isPrivate = msg.chat.type === 'private';
  if (!isGroup && !isPrivate) return;

  if (isGroup) {
    try {
      const userId = msg.from.id;
      const name = msg.from?.first_name || msg.from?.username || 'Участник';
      await send(CHAT_ID,
        `🕯 ${name}, пишу вам в личные сообщения.`
      );
      // Start the ritual in their DM
      const ns = makeNastroy(userId, name);
      nastroySessions.set(String(userId), ns);

      // Apply saved framing preference
      const profile = getProfile(userId);
      if (profile.framing) ns.framing = profile.framing;

      await showIntro(String(userId), ns);
    } catch (e) {
      console.error('Failed to DM user:', e.message);
      await send(CHAT_ID,
        `Не могу написать вам в личные сообщения — сначала нажмите «Начать» в @writeous_nastroybot, а потом попробуйте снова.`
      ).catch(() => {});
    }
    return;
  }

  // Private chat
  const userId = msg.from.id;
  const name = msg.from?.first_name || msg.from?.username || 'Участник';
  const existingNs = nastroySessions.get(String(chatId));

  if (existingNs && existingNs.state !== 'idle') {
    await send(chatId,
      `Настройка уже идёт. Продолжите текущий шаг или напишите /cancel, чтобы начать заново.`
    );
    return;
  }

  const ns = makeNastroy(userId, name);
  nastroySessions.set(String(chatId), ns);

  const profile = getProfile(userId);
  if (profile.framing) ns.framing = profile.framing;

  await showIntro(String(chatId), ns);
});

// ---------------------------------------------------------------------------
// /stop — end active work session early, go straight to step 7
// ---------------------------------------------------------------------------

bot.onText(/\/stop/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const ns = nastroySessions.get(chatId);

  if (!ns || ns.state !== 'session_active') {
    await send(chatId, `Сейчас нет активной рабочей сессии.`);
    return;
  }

  if (ns.sessionTimeout) clearTimeout(ns.sessionTimeout);
  await endSession(chatId, ns);
});

// ---------------------------------------------------------------------------
// /cancel

bot.onText(/\/cancel/, async (msg) => {
  const chatId = String(msg.chat.id);
  const ns = nastroySessions.get(chatId);
  if (!ns) {
    await send(chatId, `Нет активной настройки.`);
    return;
  }
  if (ns.sessionTimeout) clearTimeout(ns.sessionTimeout);
  if (ns.pinnedMessageId) {
    try { await bot.unpinAllChatMessages(chatId); } catch (e) { console.error('Failed to unpin:', e.message); }
  }
  nastroySessions.delete(chatId);
  await send(chatId, `Настройка отменена. До следующего раза. 🕯`);
});

// ---------------------------------------------------------------------------
// /stats
// ---------------------------------------------------------------------------

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  const isGroup = chatId.toString() === CHAT_ID;
  if (!isPrivate && !isGroup) return;

  const userId = msg.from.id;
  const profile = getProfile(userId);

  const deepHours = fmtDuration(profile.totalDeepMs || 0);
  const sessions = profile.totalSessions || 0;
  const cycles = profile.completedCycles || 0;
  const completionRate = sessions > 0 ? Math.round((cycles / sessions) * 100) : 0;

  // Compute average session length
  const userSessions = Object.values(sessionLog).filter(s => s.userId === userId && s.startedAt && s.endedAt);
  const avgMin = userSessions.length > 0
    ? Math.round(userSessions.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0) / userSessions.length / MIN_MS)
    : 0;

  await send(isPrivate ? chatId : userId,
    `📊 *Ваша статистика НАСТРОЙ*\n\n` +
    `🟣 Глубокие часы: *${deepHours}*\n` +
    `✅ Завершённых циклов: *${cycles}* из ${sessions}\n` +
    `📈 Процент завершения: *${completionRate}%*\n` +
    `⏱ Средняя сессия: *${avgMin > 0 ? fmtMin(avgMin) : '—'}*`
  );
});

// ---------------------------------------------------------------------------
// /framing — change framing preference
// ---------------------------------------------------------------------------

bot.onText(/\/framing/, async (msg) => {
  const chatId = String(msg.chat.id);
  const isPrivate = msg.chat.type === 'private';
  if (!isPrivate) return;

  await send(chatId,
    `Выберите формат для шагов 1 и 7:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '✝️ Духовный', callback_data: 'ns:setframing:spiritual' }],
      [{ text: '🧭 Секулярный', callback_data: 'ns:setframing:secular' }],
    ] } }
  );
});

// ---------------------------------------------------------------------------
// Callback query handler
// ---------------------------------------------------------------------------

bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // Framing change from /framing command (outside a session)
  if (data.startsWith('ns:setframing:')) {
    const framing = data.split(':')[2];
    const profile = getProfile(userId);
    profile.framing = framing;
    saveProfiles();
    const label = framing === 'spiritual' ? '✝️ Духовный' : '🧭 Секулярный';
    await send(chatId, `Сохранено: ${label} формат.`);
    return;
  }

  const ns = nastroySessions.get(chatId);
  if (!ns) return;

  // ── Intro ──────────────────────────────────────────────────────────────────
  if (data === 'ns:start:no') {
    nastroySessions.delete(chatId);
    await send(chatId, `Хорошо. Когда будете готовы — /nastroy. 🕯`);
    return;
  }
  if (data === 'ns:start:yes') {
    return advanceFrom(chatId, ns, 'intro');
  }

  // ── Version ────────────────────────────────────────────────────────────────
  if (data.startsWith('ns:version:')) {
    ns.version = data.split(':')[2];
    return advanceFrom(chatId, ns, 'version');
  }

  // ── Framing ────────────────────────────────────────────────────────────────
  if (data.startsWith('ns:framing:')) {
    ns.framing = data.split(':')[2];
    const profile = getProfile(userId);
    profile.framing = ns.framing;
    saveProfiles();
    return advanceFrom(chatId, ns, 'framing');
  }

  // ── Step 1 done (spiritual) ────────────────────────────────────────────────
  if (data === 'ns:s1done') {
    ns.dedication = '[молитва]';
    return advanceFrom(chatId, ns, 'step1');
  }

  // ── Step 2 practice choice ────────────────────────────────────────────────
  if (data.startsWith('ns:s2:')) {
    const key = data.split(':')[2];
    if (key === 'custom') {
      return showStep2CustomDuration(chatId, ns);
    }
    const practice = BODY_PRACTICES.find(p => p.key === key);
    ns.bodyPractice = key;
    ns.bodyDurationMin = practice.durationMin;
    return showStep2Guidance(chatId, ns, key);
  }

  if (data === 'ns:s2done') {
    return advanceFrom(chatId, ns, 'step2');
  }

  // ── Step 3 checklist ──────────────────────────────────────────────────────
  if (data.startsWith('ns:s3toggle:')) {
    const idx = parseInt(data.split(':')[2], 10);
    ns.spaceChecklist[idx] = !ns.spaceChecklist[idx];
    // Update inline keyboard in-place
    await bot.editMessageReplyMarkup(
      spaceChecklistKeyboard(ns.spaceChecklist),
      { chat_id: chatId, message_id: query.message.message_id }
    ).catch(() => {});
    return;
  }

  if (data === 'ns:s3done') {
    const unchecked = ns.spaceChecklist
      .map((v, i) => (!v ? SPACE_ITEMS[i] : null))
      .filter(Boolean);
    if (unchecked.length > 0 && unchecked.some(item => item.includes('Телефон'))) {
      await send(chatId,
        `Готово. Заметила, что телефон пока рядом — можно вернуться к этому шагу, если хочется.`
      );
    }
    return advanceFrom(chatId, ns, 'step3');
  }

  // ── Step 4 time ───────────────────────────────────────────────────────────
  if (data.startsWith('ns:s4:')) {
    const val = data.split(':')[2];
    if (val === 'custom') {
      ns.state = 'step4_custom';
      await send(chatId, `Сколько минут? _(введите число)_`);
      return;
    }
    ns.durationMin = parseInt(val, 10);
    return advanceFrom(chatId, ns, 'step4');
  }

  // ── Session start ─────────────────────────────────────────────────────────
  if (data === 'ns:session:start') {
    return advanceFrom(chatId, ns, 'pre_session');
  }

  // ── Step 7 goal achieved ──────────────────────────────────────────────────
  if (data.startsWith('ns:s7goal:')) {
    ns.goalAchieved = data.split(':')[2];
    return advanceFrom(chatId, ns, 'step7_goal');
  }

  // ── Step 7 gratitude done ─────────────────────────────────────────────────
  if (data === 'ns:s7gratitude:done') {
    ns.gratitudeText = ns.gratitudeText || '[завершено]';
    return advanceFrom(chatId, ns, 'step7_gratitude');
  }
});

// ---------------------------------------------------------------------------
// Text message handler — routes by FSM state
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (msg.chat.type !== 'private') return; // ritual only happens in DMs

  const chatId = String(msg.chat.id);
  const ns = nastroySessions.get(chatId);
  if (!ns) return;

  const text = msg.text.trim();

  switch (ns.state) {
    case 'header_location':
      ns.location = text;
      return advanceFrom(chatId, ns, 'header_location');

    case 'header_project':
      ns.project = text;
      return advanceFrom(chatId, ns, 'header_project');

    case 'step1':
      // Only reached for secular framing (spiritual uses a button)
      if (ns.framing !== 'spiritual') {
        ns.dedication = text;
        return advanceFrom(chatId, ns, 'step1');
      }
      break;

    case 'step2_custom_duration': {
      const mins = parseInt(text, 10);
      if (isNaN(mins) || mins < 1 || mins > 120) {
        await send(chatId, `Введите число от 1 до 120.`);
        return;
      }
      ns.bodyPractice = 'custom';
      ns.bodyDurationMin = mins;
      await showStep2Guidance(chatId, ns, 'custom');
      return;
    }

    case 'step4_custom': {
      const mins = parseInt(text, 10);
      if (isNaN(mins) || mins < 5 || mins > 240) {
        await send(chatId, `Введите число от 5 до 240.`);
        return;
      }
      ns.durationMin = mins;
      return advanceFrom(chatId, ns, 'step4');
    }

    case 'step5':
      ns.mentalSet = text;
      return advanceFrom(chatId, ns, 'step5');

    case 'step6': {
      ns.goal = text;
      // Light vague-verb check
      const isVague = VAGUE_VERBS.some(v => text.toLowerCase().includes(v));
      if (isVague) {
        await send(chatId,
          `_Подсказка:_ попробуйте сформулировать конкретнее — что именно будет готово, в каком объёме? ` +
          `Если всё равно хочется оставить как есть — просто напишите цель ещё раз.`
        );
        ns.state = 'step6_retry';
        return;
      }
      return advanceFrom(chatId, ns, 'step6');
    }

    case 'step6_retry':
      ns.goal = text;
      return advanceFrom(chatId, ns, 'step6');

    case 'step7_reflection':
      ns.reflection = text;
      return advanceFrom(chatId, ns, 'step7_reflection');

    case 'step7_next':
      ns.nextStep = text;
      return advanceFrom(chatId, ns, 'step7_next');

    case 'step7_gratitude':
      // Secular users can type gratitude text or use the button
      if (ns.framing !== 'spiritual') {
        ns.gratitudeText = text;
        return advanceFrom(chatId, ns, 'step7_gratitude');
      }
      break;
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('🕯 НАСТРОЙ bot is running.');
