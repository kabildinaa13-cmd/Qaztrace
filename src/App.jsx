import { Bell, Bot, Building2, FolderOpen, LayoutDashboard, ListChecks, MessageCircle, Moon, Network, PanelLeftClose, PanelLeftOpen, PlugZap, Route as RouteIcon, ScrollText, Send, ShieldAlert, Shuffle, Sun, WalletCards, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteWatchlistRule,
  listAlertEvents,
  listWatchlistRules,
  pollWatchlistNow,
  upsertWatchlistRule,
} from "./services/alertApi";
import { getArkhamAddressIntelligence } from "./services/arkhamApi";
import { listAuditEvents } from "./services/auditApi";
import { clearAuthSession, getCurrentUser, loadAuthSession, loginUser, registerUser } from "./services/authApi";
import { attributeAddresses } from "./services/attributionApi";
import { askInvestigatorAssistant, getAssistantStatus } from "./services/assistantApi";
import { deleteInvestigationCase, listInvestigationCases, upsertInvestigationCase } from "./services/caseApi";
import { EVM_NETWORKS } from "./services/evmNetworks";
import { deleteEntityLabel, importCsvEntityLabels, importOfacEntityLabels, listEntityLabels, upsertEntityLabel } from "./services/entityApi";
import { getProviderCapabilities } from "./services/providerApi";
import { getLatestMixerChainScan, getMixerChainScan, getWalletGraph, getWalletGraphNeighbors, getWalletNfts, getWalletRisk, getWalletTokens, listWalletTransactions, traceWalletFunds } from "./services/transactionApi";
import { analyzeV2AddressConnections, listV2Transactions } from "./services/transactionV2Api";
import { deleteWalletProfile, getWalletLiveProfile, listWalletProfiles, upsertWalletProfile } from "./services/walletApi";
import authBackground from "./assets/chainsentinel-auth-bg.png";

const iconifyProtocol = import.meta.env.VITE_ICONIFY_PROTOCOL || "https";
const iconifyHost = import.meta.env.VITE_ICONIFY_HOST || "api.iconify.design";

const networkProfiles = {
  ETH: { name: "Ethereum", risk: 0, tx: "0", routes: 0, exits: 0 },
  BTC: { name: "Bitcoin", risk: 0, tx: "0", routes: 0, exits: 0 },
  TRX: { name: "TRON", risk: 0, tx: "0", routes: 0, exits: 0 },
  BNB: { name: "BNB Chain", risk: 0, tx: "0", routes: 0, exits: 0 },
  SOL: { name: "Solana", risk: 0, tx: "0", routes: 0, exits: 0 },
  STARKNET: { name: "Starknet", risk: 0, tx: "0", routes: 0, exits: 0 },
  UNKNOWN: { name: "Unknown", risk: 0, tx: "0", routes: 0, exits: 0 },
  ...Object.fromEntries(
    EVM_NETWORKS.map((network) => [
      network.key,
      {
        name: network.name,
        risk: 0,
        tx: "0",
        routes: 0,
        exits: 0,
      },
    ])
  ),
};

function detectNetwork(value) {
  const normalized = value.trim();

  if (/^T[A-Za-z0-9]{25,40}$/.test(normalized)) {
    return "TRX";
  }

  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/i.test(normalized)) {
    return "BTC";
  }

  if (/^0x[a-fA-F0-9]{63,66}$/i.test(normalized)) {
    return "STARKNET";
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    return "ETH";
  }

  if (/^0x/i.test(normalized)) {
    return "ETH";
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized)) {
    return "SOL";
  }

  return "UNKNOWN";
}

function isBitcoinAddressValue(value) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/i.test(value || "");
}

function defaultProfileNetwork(profile) {
  if (profile.networkKey === "TRX" || profile.networkKey === "BTC") {
    return profile.networkKey;
  }

  return "ALL";
}

function profileNetworkOptions(profile) {
  if (profile.networkKey === "TRX") {
    return [{ key: "TRX", name: "TRON" }];
  }

  if (profile.networkKey === "BTC") {
    return [{ key: "BTC", name: "Bitcoin" }];
  }

  return [
    { key: "ALL", name: "Все EVM" },
    ...EVM_NETWORKS.map((network) => ({ key: network.key, name: network.name })),
  ];
}

const graphModePresets = {
  brief: {
    label: "Кратко",
    description: "корневой адрес и три следующих слоя",
    depth: 3,
    maxNodes: 30,
    perAddressLimit: 5,
  },
  triage: {
    label: "Triage",
    description: "быстрый первый слой",
    depth: 3,
    maxNodes: 70,
    perAddressLimit: 6,
  },
  trace: {
    label: "Trace",
    description: "основное расследование",
    depth: 5,
    maxNodes: 120,
    perAddressLimit: 8,
  },
  deep: {
    label: "Deep",
    description: "широкая проверка",
    depth: 8,
    maxNodes: 220,
    perAddressLimit: 12,
  },
};

const defaultGraphMode = "brief";
const defaultGraphFilters = {
  hideKnownServices: false,
  riskOnly: false,
  flowDirection: "all",
  stablecoins: true,
  services: true,
  native: true,
  minAmount: "",
  categories: {
    mixer: true,
    exchange: true,
    bridge: true,
    service: true,
    stablecoin: true,
    native: true,
    unknown: true,
  },
};
const stablecoinTokenSymbols = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USD1"]);

function walletPath(address) {
  return `/wallet/${encodeURIComponent(address)}`;
}

function sectionPath(section, address = "") {
  const encodedAddress = address ? `/${encodeURIComponent(address)}` : "";
  const addressSections = new Set(["wallet", "transactions", "trace", "graph", "mixers"]);

  if (!section || section === "overview") {
    return "/overview";
  }

  if (addressSections.has(section)) {
    return `/${section}${encodedAddress}`;
  }

  return `/${section}`;
}

function parseAppRoute() {
  const legacyHashMatch = window.location.hash.match(/^#\/([^/]+)(?:\/(.+))?$/);

  if (legacyHashMatch) {
    const section = legacyHashMatch[1] || "overview";
    const routeAddress = legacyHashMatch[2] ? decodeURIComponent(legacyHashMatch[2]) : "";
    return { section, address: routeAddress, legacy: true };
  }

  const parts = window.location.pathname.split("/").filter(Boolean);
  const section = parts[0] || "overview";
  const routeAddress = parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : "";
  const knownSections = new Set(["overview", "wallets", "wallet", "transactions", "trace", "graph", "alerts", "api", "mixers", "exchanges", "sanctions", "cases", "audit"]);

  return {
    section: knownSections.has(section) ? section : "overview",
    address: routeAddress,
    legacy: false,
  };
}

function LoadingDots({ label = "loading" }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label ? <span>{label}</span> : null}
      <span className="loading-dot inline-block h-1 w-1 rounded-full bg-current" />
      <span className="loading-dot inline-block h-1 w-1 rounded-full bg-current" />
      <span className="loading-dot inline-block h-1 w-1 rounded-full bg-current" />
    </span>
  );
}

function SkeletonBlock({ lines = 3 }) {
  return (
    <div className="grid gap-2" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div
          className="skeleton-line h-4"
          key={index}
          style={{ width: `${index % 3 === 0 ? 100 : index % 3 === 1 ? 74 : 52}%` }}
        />
      ))}
    </div>
  );
}

function LoadingOverlay({ label }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/55 backdrop-blur-[2px]">
      <div className="loading-scan rounded-lg border border-zinc-800 bg-black/90 px-4 py-3 text-xs font-semibold text-sentinel-green shadow-panel">
        <LoadingDots label={label} />
      </div>
    </div>
  );
}

const uiTranslations = {
  "financial monitoring": { en: "financial monitoring", ru: "финансовый мониторинг", kz: "қаржылық мониторинг" },
  "Обзор": { en: "Overview", ru: "Обзор", kz: "Шолу" },
  "Кошельки": { en: "Wallets", ru: "Кошельки", kz: "Әмияндар" },
  "Транзакции": { en: "Transactions", ru: "Транзакции", kz: "Транзакциялар" },
  "Граф": { en: "Graph", ru: "Граф", kz: "Граф" },
  "Уведомления": { en: "Alerts", ru: "Уведомления", kz: "Хабарламалар" },
  "API": { en: "API", ru: "API", kz: "API" },
  "Миксеры": { en: "Mixers", ru: "Миксеры", kz: "Миксерлер" },
  "Расследования": { en: "Cases", ru: "Расследования", kz: "Тергеулер" },
  "Аккаунт": { en: "Account", ru: "Аккаунт", kz: "Аккаунт" },
  "Authorized": { en: "Authorized", ru: "Авторизован", kz: "Авторизацияланған" },
  "Выйти": { en: "Logout", ru: "Выйти", kz: "Шығу" },
  "Тёмная тема": { en: "Dark theme", ru: "Тёмная тема", kz: "Қараңғы тақырып" },
  "Светлая тема": { en: "Light theme", ru: "Светлая тема", kz: "Ашық тақырып" },
  "AML workspace": { en: "AML workspace", ru: "AML рабочее место", kz: "AML жұмыс орны" },
  "Monitor. Analyze. Protect.": { en: "Monitor. Analyze. Protect.", ru: "Мониторинг. Анализ. Защита.", kz: "Мониторинг. Талдау. Қорғау." },
  "Рабочее место для on-chain расследований": {
    en: "Workspace for on-chain investigations",
    ru: "Рабочее место для on-chain расследований",
    kz: "On-chain тергеулерге арналған жұмыс орны",
  },
  "Профили кошельков, графы связей, watchlist, Telegram alerts и диагностика API в одном интерфейсе.": {
    en: "Wallet profiles, connection graphs, watchlists, Telegram alerts and API diagnostics in one interface.",
    ru: "Профили кошельков, графы связей, watchlist, Telegram alerts и диагностика API в одном интерфейсе.",
    kz: "Әмиян профильдері, байланыс графтары, watchlist, Telegram хабарламалары және API диагностикасы бір интерфейсте.",
  },
  "Wallets": { en: "Wallets", ru: "Кошельки", kz: "Әмияндар" },
  "Graphs": { en: "Graphs", ru: "Графы", kz: "Графтар" },
  "Alerts": { en: "Alerts", ru: "Уведомления", kz: "Хабарламалар" },
  "Новый профиль": { en: "New profile", ru: "Новый профиль", kz: "Жаңа профиль" },
  "Доступ к системе": { en: "System access", ru: "Доступ к системе", kz: "Жүйеге кіру" },
  "Создать аккаунт": { en: "Create account", ru: "Создать аккаунт", kz: "Аккаунт жасау" },
  "Войти в систему": { en: "Sign in to system", ru: "Войти в систему", kz: "Жүйеге кіру" },
  "Создайте отдельное пространство для кошельков, кейсов и уведомлений.": {
    en: "Create a separate workspace for wallets, cases and alerts.",
    ru: "Создайте отдельное пространство для кошельков, кейсов и уведомлений.",
    kz: "Әмияндар, кейстер және хабарламалар үшін бөлек жұмыс кеңістігін жасаңыз.",
  },
  "Откройте свои кошельки, кейсы и правила мониторинга.": {
    en: "Open your wallets, cases and monitoring rules.",
    ru: "Откройте свои кошельки, кейсы и правила мониторинга.",
    kz: "Әмияндарыңызды, кейстеріңізді және мониторинг ережелерін ашыңыз.",
  },
  "Вход": { en: "Login", ru: "Вход", kz: "Кіру" },
  "Регистрация": { en: "Register", ru: "Регистрация", kz: "Тіркелу" },
  "Login": { en: "Login", ru: "Логин", kz: "Логин" },
  "Display name": { en: "Display name", ru: "Отображаемое имя", kz: "Көрсетілетін атау" },
  "Workspace name": { en: "Workspace name", ru: "Название workspace", kz: "Workspace атауы" },
  "Password": { en: "Password", ru: "Пароль", kz: "Құпиясөз" },
  "Проверяю": { en: "Checking", ru: "Проверяю", kz: "Тексерілуде" },
  "Войти": { en: "Sign in", ru: "Войти", kz: "Кіру" },
  "Универсальный поиск адреса, tx hash или кластера": {
    en: "Universal search for address, tx hash or cluster",
    ru: "Универсальный поиск адреса, tx hash или кластера",
    kz: "Адрес, tx hash немесе кластер бойынша әмбебап іздеу",
  },
  "Проверить": { en: "Check", ru: "Проверить", kz: "Тексеру" },
  "Wallet profile": { en: "Wallet profile", ru: "Профиль кошелька", kz: "Әмиян профилі" },
  "EVM address profile": { en: "EVM address profile", ru: "Профиль EVM адреса", kz: "EVM адрес профилі" },
  "Entity:": { en: "Entity:", ru: "Entity:", kz: "Entity:" },
  "saved to local labels": { en: "saved to local labels", ru: "сохранено в локальные метки", kz: "жергілікті белгілерге сақталды" },
  "detected by Arkham": { en: "detected by Arkham", ru: "найдено через Arkham", kz: "Arkham арқылы табылды" },
  "save failed": { en: "save failed", ru: "не удалось сохранить", kz: "сақталмады" },
  "Сеть": { en: "Network", ru: "Сеть", kz: "Желі" },
  "Баланс / Tx count": { en: "Balance / Tx count", ru: "Баланс / Tx count", kz: "Баланс / Tx саны" },
  "Создан": { en: "Created", ru: "Создан", kz: "Құрылған" },
  "Последняя активность": { en: "Last activity", ru: "Последняя активность", kz: "Соңғы белсенділік" },
  "Aggregated AML score": { en: "Aggregated AML score", ru: "Сводный AML score", kz: "Жиынтық AML score" },
  "Ожидание risk analysis": { en: "Waiting for risk analysis", ru: "Ожидание risk analysis", kz: "Risk analysis күтілуде" },
  "Сильных risk-факторов по доступным источникам не найдено.": {
    en: "No strong risk factors were found in the available sources.",
    ru: "Сильных risk-факторов по доступным источникам не найдено.",
    kz: "Қолжетімді дереккөздерден күшті risk-факторлар табылмады.",
  },
  "Investigation workspace": { en: "Investigation workspace", ru: "Рабочая область расследования", kz: "Тергеу жұмыс аймағы" },
  "Следующие проверки": { en: "Next checks", ru: "Следующие проверки", kz: "Келесі тексерулер" },
  "Полная история": { en: "Full history", ru: "Полная история", kz: "Толық тарих" },
  "Граф связей": { en: "Connection graph", ru: "Граф связей", kz: "Байланыстар графы" },
  "Exit-address": { en: "Exit address", ru: "Exit-address", kz: "Exit-address" },
  "EVM token holdings": { en: "EVM token holdings", ru: "EVM токены", kz: "EVM токендері" },
  "NFT exposure": { en: "NFT exposure", ru: "NFT exposure", kz: "NFT exposure" },
  "Provider warnings": { en: "Provider warnings", ru: "Предупреждения provider", kz: "Provider ескертулері" },
  "Arkham intelligence": { en: "Arkham intelligence", ru: "Arkham intelligence", kz: "Arkham intelligence" },
  "Entity enrichment": { en: "Entity enrichment", ru: "Entity enrichment", kz: "Entity enrichment" },
  "loaded": { en: "loaded", ru: "загружено", kz: "жүктелді" },
  "error": { en: "error", ru: "ошибка", kz: "қате" },
  "idle": { en: "idle", ru: "ожидание", kz: "күту" },
  "loading": { en: "loading", ru: "загрузка", kz: "жүктелуде" },
  "Entities": { en: "Entities", ru: "Entities", kz: "Entities" },
  "Labels": { en: "Labels", ru: "Метки", kz: "Белгілер" },
  "Tags": { en: "Tags", ru: "Теги", kz: "Тегтер" },
  "Actions": { en: "Actions", ru: "Действия", kz: "Әрекеттер" },
  "Действия": { en: "Actions", ru: "Действия", kz: "Әрекеттер" },
  "Добавить": { en: "Add", ru: "Добавить", kz: "Қосу" },
  "Удалить": { en: "Delete", ru: "Удалить", kz: "Жою" },
  "Сохранить": { en: "Save", ru: "Сохранить", kz: "Сақтау" },
  "Обновить": { en: "Refresh", ru: "Обновить", kz: "Жаңарту" },
  "Открыть": { en: "Open", ru: "Открыть", kz: "Ашу" },
  "Закрыть": { en: "Close", ru: "Закрыть", kz: "Жабу" },
  "Экспорт JSON": { en: "Export JSON", ru: "Экспорт JSON", kz: "JSON экспорт" },
  "Сохранить кейс": { en: "Save case", ru: "Сохранить кейс", kz: "Кейсті сақтау" },
  "Новый граф": { en: "New graph", ru: "Новый граф", kz: "Жаңа граф" },
  "Адрес": { en: "Address", ru: "Адрес", kz: "Адрес" },
  "Статус": { en: "Status", ru: "Статус", kz: "Статус" },
  "Правило": { en: "Rule", ru: "Правило", kz: "Ереже" },
  "Порог": { en: "Threshold", ru: "Порог", kz: "Шек" },
  "active": { en: "active", ru: "активно", kz: "белсенді" },
  "low risk": { en: "low risk", ru: "низкий риск", kz: "төмен тәуекел" },
  "medium risk": { en: "medium risk", ru: "средний риск", kz: "орташа тәуекел" },
  "high risk": { en: "high risk", ru: "высокий риск", kz: "жоғары тәуекел" },
  "critical risk": { en: "critical risk", ru: "критический риск", kz: "критикалық тәуекел" },
  "confidence": { en: "confidence", ru: "уверенность", kz: "сенімділік" },
  "risk score": { en: "risk score", ru: "risk score", kz: "risk score" },
  "Всего contracts": { en: "Total contracts", ru: "Всего contracts", kz: "Барлық contracts" },
  "Non-zero": { en: "Non-zero", ru: "Ненулевые", kz: "Нөл емес" },
  "Shown": { en: "Shown", ru: "Показано", kz: "Көрсетілді" },
  "Networks": { en: "Networks", ru: "Сети", kz: "Желілер" },
};

const translationIndex = new Map();
for (const [source, values] of Object.entries(uiTranslations)) {
  translationIndex.set(source.toLowerCase(), source);
  for (const value of Object.values(values)) {
    translationIndex.set(String(value).toLowerCase(), source);
  }
}

function translateUiText(value, language) {
  if (language === "ru") {
    return uiTranslations[value]?.ru || value;
  }

  const trimmed = String(value || "").trim();
  const key = translationIndex.get(trimmed.toLowerCase());

  if (!key) {
    return value;
  }

  return uiTranslations[key]?.[language] || uiTranslations[key]?.ru || value;
}

function useDocumentTranslation(language) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return undefined;

    const skipTags = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE"]);
    const translateNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || "";
        const trimmed = text.trim();

        if (!trimmed || /^[#:/0-9a-fx.,\s%-]+$/i.test(trimmed)) {
          return;
        }

        const translated = translateUiText(trimmed, language);
        if (translated !== trimmed) {
          node.nodeValue = text.replace(trimmed, translated);
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE || skipTags.has(node.tagName)) {
        return;
      }

      for (const attr of ["title", "aria-label", "placeholder"]) {
        const value = node.getAttribute?.(attr);
        if (value) {
          const translated = translateUiText(value, language);
          if (translated !== value) {
            node.setAttribute(attr, translated);
          }
        }
      }

      node.childNodes.forEach(translateNode);
    };

    translateNode(root);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(translateNode);
        if (mutation.type === "characterData") {
          translateNode(mutation.target);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });

    return () => observer.disconnect();
  }, [language]);
}

const assistantPageNames = {
  overview: "Обзор",
  wallets: "Кошельки",
  wallet: "Карточка кошелька",
  transactions: "Транзакции",
  trace: "Трассировка",
  graph: "Граф",
  alerts: "Уведомления",
  api: "API",
  mixers: "Миксеры",
  exchanges: "Биржи",
  sanctions: "Risk DB",
  cases: "Расследования",
};

function assistantSuggestions(section, address) {
  const common = ["Объясни эту страницу простыми словами"];

  if (section === "transactions") {
    return [...common, "Как продолжить путь денег по транзакциям?", "Что здесь является доказанным фактом?"];
  }
  if (section === "trace" || section === "graph") {
    return [...common, "Как понять, куда в итоге ушли деньги?", "Что означает вероятная связь?"];
  }
  if (section === "exchanges") {
    return [...common, "Как установить биржу и владельца кошелька?", "Что делать, если биржа не найдена?"];
  }
  if (section === "mixers") {
    return [...common, "Как доказать контакт с миксером?", "Какие признаки не являются доказательством?"];
  }
  if (address) {
    return [...common, "Что можно установить об этом кошельке?", "Какой следующий шаг проверки?"];
  }
  return [...common, "С чего начать проверку адреса?", "Как подготовить материалы для следователя?"];
}

function useSessionState(key, fallbackValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored);
    } catch {
      // Повреждённое или слишком большое состояние не должно ломать страницу.
    }
    return typeof fallbackValue === "function" ? fallbackValue() : fallbackValue;
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Браузер может ограничить объём sessionStorage; интерфейс продолжит работать в памяти.
    }
  }, [key, value]);

  return [value, setValue];
}

function InvestigatorAssistant({ section, address, network }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([
    {
      id: "assistant-welcome",
      role: "assistant",
      content: "Здравствуйте. Я объясню любой раздел простыми словами и подскажу следующий шаг проверки. Я не выдаю предположения за доказанные факты.",
      provider: "builtin",
    },
  ]);
  const messageCounterRef = useRef(0);
  const messageListRef = useRef(null);
  const suggestions = assistantSuggestions(section, address);

  useEffect(() => {
    if (!open || status) return;
    let cancelled = false;

    getAssistantStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false, mode: "builtin" });
      });

    return () => {
      cancelled = true;
    };
  }, [open, status]);

  useEffect(() => {
    if (!open || !messageListRef.current) return;
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [loading, messages, open]);

  const appendAssistantError = (message) => {
    messageCounterRef.current += 1;
    setMessages((current) => [
      ...current,
      {
        id: `assistant-error-${messageCounterRef.current}`,
        role: "assistant",
        content: `Не удалось получить ответ: ${message}. Проверьте, что API запущен командой npm run api.`,
        provider: "error",
      },
    ]);
  };

  const sendMessage = async (rawMessage) => {
    const cleanMessage = String(rawMessage || "").trim();
    if (!cleanMessage || loading) return;

    messageCounterRef.current += 1;
    const userMessage = {
      id: `assistant-user-${messageCounterRef.current}`,
      role: "user",
      content: cleanMessage,
    };
    const history = messages
      .filter((item) => ["user", "assistant"].includes(item.role))
      .slice(-8)
      .map(({ role, content }) => ({ role, content }));

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const result = await askInvestigatorAssistant({
        message: cleanMessage,
        history,
        context: {
          section,
          pageName: assistantPageNames[section] || section,
          address,
          network,
          pageUrl: window.location.pathname,
        },
      });

      messageCounterRef.current += 1;
      setMessages((current) => [
        ...current,
        {
          id: `assistant-reply-${messageCounterRef.current}`,
          role: "assistant",
          content: result.reply,
          provider: result.provider,
          model: result.model,
        },
      ]);
      setStatus((current) => ({
        ...(current || {}),
        available: result.provider === "ollama",
        mode: result.provider === "ollama" ? "ollama" : "builtin",
        model: result.model,
        setupCommand: result.setupCommand || current?.setupCommand,
      }));
    } catch (error) {
      appendAssistantError(error.message || "неизвестная ошибка");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-[80] max-[640px]:bottom-3 max-[640px]:right-3">
      {open ? (
        <section
          aria-label="ИИ-помощник следователя"
          className="mb-3 flex h-[min(680px,76vh)] w-[410px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-ink-950 shadow-2xl shadow-black/70"
        >
          <header className="flex items-center gap-3 border-b border-zinc-800 bg-black px-4 py-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-sentinel-green/40 bg-sentinel-green/10 text-sentinel-green">
              <Bot size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-zinc-100">Помощник следователя</h2>
              <div className="mt-1 flex items-center gap-2 text-[11px]">
                <span className={`h-1.5 w-1.5 rounded-full ${status?.available ? "bg-sentinel-green" : "bg-sentinel-warning"}`} />
                <span className={status?.available ? "text-sentinel-green" : "text-zinc-500"}>
                  {status?.available ? `Локальный ИИ · ${status.model}` : "Встроенный безопасный режим"}
                </span>
              </div>
            </div>
            <button
              aria-label="Закрыть ИИ-помощника"
              className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-800 text-zinc-500 hover:text-white"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X size={17} />
            </button>
          </header>

          <div className="border-b border-zinc-900 bg-zinc-950 px-4 py-2 text-[11px] text-zinc-600">
            Раздел: <span className="text-zinc-400">{assistantPageNames[section] || section}</span>
            {address ? <> · адрес <span className="font-mono text-zinc-400">{address.slice(0, 8)}…{address.slice(-6)}</span></> : null}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4" ref={messageListRef}>
            <div className="grid gap-3">
              {messages.map((message) => (
                <article
                  className={`max-w-[88%] rounded-xl px-3 py-2.5 text-sm leading-6 ${
                    message.role === "user"
                      ? "ml-auto bg-sentinel-green text-black"
                      : "border border-zinc-800 bg-black text-zinc-300"
                  }`}
                  key={message.id}
                >
                  <p className="whitespace-pre-wrap">{message.content}</p>
                  {message.role === "assistant" && message.provider === "ollama" ? (
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-zinc-600">Локальная модель · данные не отправлены в облако</p>
                  ) : null}
                </article>
              ))}
              {loading ? (
                <div className="w-fit rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm text-zinc-500">
                  <LoadingDots label="Анализирую" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="border-t border-zinc-800 bg-black p-3">
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
              {suggestions.map((suggestion) => (
                <button
                  className="min-h-8 shrink-0 rounded-full border border-zinc-800 bg-zinc-950 px-3 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-white"
                  disabled={loading}
                  key={suggestion}
                  onClick={() => sendMessage(suggestion)}
                  type="button"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); sendMessage(input); }}>
              <textarea
                aria-label="Вопрос ИИ-помощнику"
                className="max-h-28 min-h-11 flex-1 resize-none rounded-xl border border-zinc-800 bg-ink-950 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sentinel-green/60"
                disabled={loading}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage(input);
                  }
                }}
                placeholder="Спросите, что означает показатель или что делать дальше…"
                rows={1}
                value={input}
              />
              <button
                aria-label="Отправить вопрос"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sentinel-green text-black disabled:opacity-40"
                disabled={loading || !input.trim()}
                type="submit"
              >
                <Send size={18} />
              </button>
            </form>
            <p className="mt-2 text-center text-[10px] text-zinc-700">Проверяйте выводы: помощник не устанавливает виновность и личность автоматически.</p>
          </div>
        </section>
      ) : null}

      {!open ? (
        <button
          aria-label="Открыть ИИ-помощника"
          className="ml-auto flex min-h-12 items-center gap-2 rounded-full border border-sentinel-green/50 bg-sentinel-green px-4 font-semibold text-black shadow-xl shadow-black/50 transition-transform hover:scale-[1.02]"
          onClick={() => setOpen(true)}
          type="button"
        >
          <MessageCircle size={18} />
          <span>Спросить ИИ</span>
        </button>
      ) : null}
    </div>
  );
}

function App() {
  const [activeSection, setActiveSection] = useState("overview");
  const [authSession, setAuthSession] = useState(loadAuthSession);
  const authUser = authSession?.user || null;
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => authUser?.id || "");
  const [address, setAddress] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [detectedNetwork, setDetectedNetwork] = useState("ETH");
  const [liveData, setLiveData] = useState(null);
  const [networkCandidates, setNetworkCandidates] = useState([]);
  const [walletProfiles, setWalletProfiles] = useState([]);
  const [watchlistRules, setWatchlistRules] = useState([]);
  const [alertEvents, setAlertEvents] = useState([]);
  const [providerCapabilities, setProviderCapabilities] = useState(null);
  const [providerError, setProviderError] = useState("");
  const [restoredCase, setRestoredCase] = useState(null);
  const [selectedWalletAddress, setSelectedWalletAddress] = useState("");
  const [rpcStatus, setRpcStatus] = useState("idle");
  const [rpcError, setRpcError] = useState("");
  const [watchEnabled, setWatchEnabled] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("chainsentinelTheme") || "dark");
  const [language, setLanguage] = useState(() => localStorage.getItem("chainsentinelLanguage") || "ru");
  const [fontScale, setFontScale] = useState(() => localStorage.getItem("chainsentinelFontScale") || "normal");
  const analyzeAndSaveWalletRef = useRef(null);
  const previousWorkspaceIdRef = useRef(activeWorkspaceId);
  const [feed, setFeed] = useState([]);
  const activeWorkspace = authUser
    ? { id: authUser.id, name: authUser.displayName || authUser.username }
    : { id: "", name: "" };

  useEffect(() => {
    // Старые ключи могли остаться в браузере после предыдущей версии.
    // Новая версия их не использует и удаляет, чтобы исключить случайный расход чужих кредитов.
    localStorage.removeItem("infuraApiKey");
    localStorage.removeItem("tronGridApiKey");
  }, []);

  useEffect(() => {
    localStorage.setItem("chainsentinelTheme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("chainsentinelLanguage", language);
    document.documentElement.lang = language === "kz" ? "kk" : language;
  }, [language]);

  useEffect(() => {
    const sizes = {
      compact: "15.5px",
      normal: "16.5px",
      large: "17.5px",
    };
    const safeScale = sizes[fontScale] ? fontScale : "normal";
    localStorage.setItem("chainsentinelFontScale", safeScale);
    document.documentElement.style.setProperty("--app-font-size", sizes[safeScale]);
  }, [fontScale]);

  useDocumentTranslation(language);

  useEffect(() => {
    setActiveWorkspaceId(authUser?.id || "");
  }, [authUser?.id]);

  useEffect(() => {
    if (!authSession?.token) {
      return;
    }

    let cancelled = false;

    getCurrentUser()
      .then((result) => {
        if (!cancelled && result.user?.id && result.user.id !== authSession.user?.id) {
          setAuthSession((current) => ({ ...current, user: result.user }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearAuthSession();
          setAuthSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authSession?.token]);

  useEffect(() => {
    let cancelled = false;

    if (!activeWorkspaceId) {
      setWalletProfiles([]);
      return () => {
        cancelled = true;
      };
    }

    listWalletProfiles(activeWorkspaceId)
      .then((profiles) => {
        if (!cancelled) {
          setWalletProfiles(profiles);
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearAuthSession();
          setAuthSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    getProviderCapabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setProviderCapabilities(capabilities);
          setProviderError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProviderError(error.message || "Provider status unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!activeWorkspaceId) {
      setWatchlistRules([]);
      setAlertEvents([]);
      return () => {
        cancelled = true;
      };
    }

    Promise.all([listWatchlistRules(activeWorkspaceId), listAlertEvents(activeWorkspaceId)])
      .then(([rules, events]) => {
        if (!cancelled) {
          setWatchlistRules(rules);
          setAlertEvents(events);
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearAuthSession();
          setAuthSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    if (previousWorkspaceIdRef.current === activeWorkspaceId) {
      return;
    }

    previousWorkspaceIdRef.current = activeWorkspaceId;
    setAddress("");
    setSearchValue("");
    setSelectedWalletAddress("");
    setLiveData(null);
    setNetworkCandidates([]);
    setRpcStatus("idle");
    setRpcError("");
    setRestoredCase(null);
    setWatchEnabled(false);
    setFeed([]);
    window.history.replaceState({}, "", "/overview");
  }, [activeWorkspaceId]);

  useEffect(() => {
    const syncRoute = () => {
      applyRoute(parseAppRoute());
    };

    syncRoute();
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, [walletProfiles]);

  const profile = {
    ...(networkProfiles[detectedNetwork] || networkProfiles.UNKNOWN),
    networkKey: detectedNetwork,
    tx: liveData ? String(liveData.txCount) : (networkProfiles[detectedNetwork] || networkProfiles.UNKNOWN).tx,
    latestBlock: liveData?.blockNumber,
    balance: liveData?.balance,
    symbol: liveData?.symbol,
    source: liveData?.source,
    latestActivityAt: liveData?.latestActivityAt,
    accountCreatedAt: liveData?.accountCreatedAt,
    tokens: liveData?.tokens || [],
    watchlistCount: watchlistRules.filter((rule) => rule.address?.toLowerCase() === address.toLowerCase()).length,
    networkCandidates,
  };

  const applyRoute = (route = parseAppRoute(), options = {}) => {
    const nextSection = route.section || "overview";
    const routedAddress = route.address || "";

    if (route.legacy) {
      window.history.replaceState({}, "", sectionPath(nextSection, routedAddress));
    }

    setActiveSection(nextSection);

    if (routedAddress) {
      const wallet = walletProfiles.find((item) => item.address === routedAddress);
      setSelectedWalletAddress(routedAddress);
      setAddress(routedAddress);
      setSearchValue(routedAddress);

      if (wallet) {
        setDetectedNetwork(wallet.networkKey);
        setLiveData(wallet.liveData || null);
        setNetworkCandidates(wallet.networkCandidates || []);
        setRpcError(wallet.rpcError || "");
        setRpcStatus(wallet.liveData ? "success" : "idle");
      } else {
        setDetectedNetwork(detectNetwork(routedAddress));
        setLiveData(null);
        setNetworkCandidates([]);
        setRpcError("");
        setRpcStatus("idle");
      }
    } else if (nextSection === "overview" && options.clearAddress) {
      setSelectedWalletAddress("");
      setAddress("");
      setSearchValue("");
      setLiveData(null);
      setNetworkCandidates([]);
      setRpcError("");
      setRpcStatus("idle");
    }
  };

  const navigateTo = (section, nextAddress = address, options = {}) => {
    const cleanAddress = String(nextAddress || "").trim();
    const path = sectionPath(section, cleanAddress);
    const method = options.replace ? "replaceState" : "pushState";

    if (window.location.pathname !== path || window.location.hash) {
      window.history[method]({}, "", path);
    }

    applyRoute({ section, address: cleanAddress, legacy: false }, options);
  };

  const handleAuthSuccess = (session) => {
    setAuthSession(session);
    const pendingRoute = parseAppRoute();
    if (pendingRoute.address || pendingRoute.section !== "overview") {
      navigateTo(pendingRoute.section, pendingRoute.address, { replace: true });
    } else {
      navigateTo("overview", "", { replace: true, clearAddress: true });
    }
  };

  const logout = () => {
    clearAuthSession();
    setAuthSession(null);
    setAddress("");
    setSearchValue("");
    setSelectedWalletAddress("");
    setWalletProfiles([]);
    setWatchlistRules([]);
    setAlertEvents([]);
    setLiveData(null);
    setNetworkCandidates([]);
    setFeed([]);
    window.history.replaceState({}, "", "/overview");
  };
  const addFeed = (message) => {
    setFeed((current) => [message, ...current].slice(0, 5));
  };

  const persistWalletProfile = (wallet) => {
    const scopedWallet = { ...wallet, profileId: activeWorkspaceId };
    setWalletProfiles((current) => {
      const next = [scopedWallet, ...current.filter((item) => item.address !== scopedWallet.address)].slice(0, 50);
      return next;
    });
    upsertWalletProfile(scopedWallet, activeWorkspaceId).then((savedWallet) => {
      setWalletProfiles((current) => [
        savedWallet,
        ...current.filter((item) => item.address !== savedWallet.address),
      ]);
    });
  };

  const removeWalletProfile = (wallet) => {
    setWalletProfiles((current) => current.filter((item) => item.address !== wallet.address));
    deleteWalletProfile(wallet.address, activeWorkspaceId);

    if (selectedWalletAddress === wallet.address) {
      setSelectedWalletAddress("");
      setAddress("");
      setSearchValue("");
      setLiveData(null);
      setNetworkCandidates([]);
      navigateTo("wallets", "", { replace: true });
    }
  };

  const openInvestigationCase = (item) => {
    const caseNetwork = item.graphState?.params?.networkFilter || item.networkKey || detectNetwork(item.rootAddress);
    const nextNetwork = caseNetwork === "ALL" ? detectNetwork(item.rootAddress) : caseNetwork;

    setRestoredCase(item);
    setAddress(item.rootAddress);
    setSearchValue(item.rootAddress);
    setSelectedWalletAddress(item.rootAddress);
    setDetectedNetwork(nextNetwork);
    setLiveData(null);
    setNetworkCandidates([]);
    setRpcError("");
    setRpcStatus("idle");
    navigateTo(item.traceReport ? "trace" : "graph", item.rootAddress);
    addFeed(`Кейс открыт: ${item.title}`);
  };

  const saveWatchlistRule = async (rule) => {
    const savedRule = await upsertWatchlistRule({ ...rule, profileId: activeWorkspaceId }, activeWorkspaceId);
    setWatchlistRules((current) => [savedRule, ...current.filter((item) => item.id !== savedRule.id)]);
    return savedRule;
  };

  const removeWatchlistRule = (rule) => {
    setWatchlistRules((current) => current.filter((item) => item.id !== rule.id));
    deleteWatchlistRule(rule.id);
  };

  const pollWatchlist = async () => {
    const result = await pollWatchlistNow(activeWorkspaceId);
    const events = await listAlertEvents(activeWorkspaceId);
    setAlertEvents(events);
    addFeed(`Watchlist проверен: ${result.checkedRules} правил, alerts ${result.alertsCreated}`);
    return result;
  };

  const analyzeAndSaveWallet = async (nextAddress, forceRefresh = false) => {
    const cleanAddress = nextAddress.trim();

    if (!cleanAddress) {
      return;
    }

    const existingWallet = walletProfiles.find((item) => item.address === cleanAddress);

    if (existingWallet?.liveData && !forceRefresh) {
      setSelectedWalletAddress(existingWallet.address);
      setAddress(existingWallet.address);
      setDetectedNetwork(existingWallet.networkKey);
      setLiveData(existingWallet.liveData || null);
      setNetworkCandidates(existingWallet.networkCandidates || []);
      setRpcError(existingWallet.rpcError || "");
      setRpcStatus(existingWallet.liveData ? "success" : "idle");
      navigateTo("wallet", existingWallet.address);
      return;
    }

    const nextNetwork = detectNetwork(cleanAddress);

    setAddress(cleanAddress);
    setSearchValue(cleanAddress);
    setSelectedWalletAddress(cleanAddress);
    setDetectedNetwork(nextNetwork);
    setLiveData(null);
    setNetworkCandidates([]);
    setRpcError("");

    if (/^0x[a-fA-F0-9]{40}$/.test(cleanAddress)) {
      setRpcStatus("loading");

      try {
        const analysis = await getWalletLiveProfile(cleanAddress);
        const selected = analysis.selected;

        const wallet = {
          address: cleanAddress,
          networkKey: selected.networkKey,
          networkName: selected.networkName,
          liveData: selected,
          networkCandidates: analysis.candidates,
          rpcError: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        setLiveData(wallet.liveData);
        setNetworkCandidates(wallet.networkCandidates);
        setDetectedNetwork(selected.networkKey);
        setRpcStatus("success");
        persistWalletProfile(wallet);
        navigateTo("wallet", cleanAddress);
        addFeed(
          `${cleanAddress}: ${selected.networkName}, balance ${selected.balance} ${selected.symbol}, tx count ${selected.txCount}`
        );
      } catch (error) {
        const wallet = {
          address: cleanAddress,
          networkKey: nextNetwork,
          networkName: (networkProfiles[nextNetwork] || networkProfiles.UNKNOWN).name,
          liveData: null,
          networkCandidates: [],
          rpcError: error.message,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        setRpcStatus("error");
        setRpcError(error.message);
        persistWalletProfile(wallet);
        navigateTo("wallet", cleanAddress);
        addFeed(`${cleanAddress}: ошибка публичного EVM-источника - ${error.message}`);
      }

      return;
    }

    if (nextNetwork === "TRX" || nextNetwork === "BTC") {
      setRpcStatus("loading");

      try {
        const analysis = await getWalletLiveProfile(cleanAddress);
        const selected = analysis.selected;
        const wallet = {
          address: cleanAddress,
          networkKey: selected.networkKey,
          networkName: selected.networkName,
          liveData: selected,
          networkCandidates: analysis.candidates,
          rpcError: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        setLiveData(wallet.liveData);
        setNetworkCandidates(wallet.networkCandidates);
        setDetectedNetwork(selected.networkKey);
        setRpcStatus("success");
        persistWalletProfile(wallet);
        navigateTo("wallet", cleanAddress);
        addFeed(`${cleanAddress}: ${selected.networkName}, balance ${selected.balance} ${selected.symbol}, tx count ${selected.txCount}`);
      } catch (error) {
        const wallet = {
          address: cleanAddress,
          networkKey: nextNetwork,
          networkName: (networkProfiles[nextNetwork] || networkProfiles.UNKNOWN).name,
          liveData: null,
          networkCandidates: [],
          rpcError: error.message,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        setRpcStatus("error");
        setRpcError(error.message);
        persistWalletProfile(wallet);
        navigateTo("wallet", cleanAddress);
        addFeed(`${cleanAddress}: ошибка ${(networkProfiles[nextNetwork] || networkProfiles.UNKNOWN).name} API - ${error.message}`);
      }

      return;
    }

    persistWalletProfile({
      address: cleanAddress,
      networkKey: nextNetwork,
      networkName: (networkProfiles[nextNetwork] || networkProfiles.UNKNOWN).name,
      liveData: null,
      networkCandidates: [],
      rpcError: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    navigateTo("wallet", cleanAddress);
    setRpcStatus("idle");
    addFeed(
      `${cleanAddress}: сеть ${(networkProfiles[nextNetwork] || networkProfiles.UNKNOWN).name}, для этой сети нужен отдельный data provider`
    );
  };
  analyzeAndSaveWalletRef.current = analyzeAndSaveWallet;

  const submitSearch = async (event) => {
    event.preventDefault();
    await analyzeAndSaveWallet(searchValue, false);
  };

  useEffect(() => {
    const liveSupported = /^0x[a-fA-F0-9]{40}$/.test(address) || /^T[A-Za-z0-9]{25,40}$/.test(address) || isBitcoinAddressValue(address);

    if (activeSection !== "wallet" || !address || liveData || rpcStatus === "loading" || !liveSupported) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      analyzeAndSaveWalletRef.current?.(address, true);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [activeSection, address, liveData, rpcStatus]);

  if (!authUser) {
    return <AuthScreen language={language} onAuthSuccess={handleAuthSuccess} setLanguage={setLanguage} />;
  }

  return (
    <div className={`min-h-screen overflow-x-hidden bg-ink-950 text-zinc-100 ${theme === "light" ? "theme-light" : "theme-dark"}`}>
      <div className={`grid min-h-screen w-full max-w-full overflow-x-hidden ${sidebarCollapsed ? "grid-cols-[82px_minmax(0,1fr)]" : "grid-cols-[248px_minmax(0,1fr)]"} max-[760px]:block`}>
        <Sidebar
          activeSection={activeSection}
          activeWorkspaceId={activeWorkspaceId}
          authUser={authUser}
          collapsed={sidebarCollapsed}
          detectedNetwork={profile.name}
          fontScale={fontScale}
          language={language}
          logout={logout}
          setActiveSection={(section) => navigateTo(section, address, { clearAddress: section === "overview" })}
          setCollapsed={setSidebarCollapsed}
          setFontScale={setFontScale}
          setLanguage={setLanguage}
          setTheme={setTheme}
          theme={theme}
          walletCount={walletProfiles.length}
        />

        <main className="min-w-0 max-w-full overflow-x-hidden px-5 py-4 max-[760px]:px-3">
          {activeSection !== "overview" ? (
            <Header
              searchValue={searchValue}
              setSearchValue={setSearchValue}
              onSubmit={submitSearch}
            />
          ) : null}

          <ActiveSection
            activeSection={activeSection}
            setActiveSection={(section) => navigateTo(section, address, { clearAddress: section === "overview" })}
            activeWorkspaceId={activeWorkspaceId}
            activeWorkspaceName={activeWorkspace.name}
            address={address}
            profile={profile}
            rpcError={rpcError}
            networkCandidates={networkCandidates}
            watchEnabled={watchEnabled}
            setWatchEnabled={setWatchEnabled}
            telegramEnabled={telegramEnabled}
            setTelegramEnabled={setTelegramEnabled}
            feed={feed}
            addFeed={addFeed}
            watchlistRules={watchlistRules}
            alertEvents={alertEvents}
            providerCapabilities={providerCapabilities}
            providerError={providerError}
            saveWatchlistRule={saveWatchlistRule}
            removeWatchlistRule={removeWatchlistRule}
            pollWatchlist={pollWatchlist}
            searchValue={searchValue}
            setSearchValue={setSearchValue}
            onSubmit={submitSearch}
            walletProfiles={walletProfiles}
            selectedWalletAddress={selectedWalletAddress}
            restoredCase={restoredCase}
            openInvestigationCase={openInvestigationCase}
            selectNetworkCandidate={(candidate) => {
              if (!candidate?.networkKey) return;
              setDetectedNetwork(candidate.networkKey);
              setLiveData(candidate);
              setRpcStatus("success");
              setRpcError("");
              persistWalletProfile({
                address,
                networkKey: candidate.networkKey,
                networkName: candidate.networkName,
                liveData: candidate,
                networkCandidates,
                rpcError: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              addFeed(`${address}: активная сеть ${candidate.networkName}`);
            }}
            openWallet={(wallet) => {
              navigateTo("wallet", wallet.address);
            }}
            openTransactions={(nextAddress) => {
              navigateTo("transactions", nextAddress);
            }}
            deleteWallet={removeWalletProfile}
            refreshWallet={() => analyzeAndSaveWallet(address, true)}
          />
        </main>
      </div>
      <InvestigatorAssistant address={address} network={profile.name} section={activeSection} />
    </div>
  );
}

function ActiveSection({
  activeSection,
  setActiveSection,
  activeWorkspaceId,
  activeWorkspaceName,
  address,
  profile,
  rpcError,
  networkCandidates,
  watchEnabled,
  setWatchEnabled,
  telegramEnabled,
  setTelegramEnabled,
  feed,
  addFeed,
  watchlistRules,
  alertEvents,
  providerCapabilities,
  providerError,
  saveWatchlistRule,
  removeWatchlistRule,
  pollWatchlist,
  searchValue,
  setSearchValue,
  onSubmit,
  walletProfiles,
  restoredCase,
  openInvestigationCase,
  selectNetworkCandidate,
  openWallet,
  openTransactions,
  deleteWallet,
  refreshWallet,
}) {
  if (activeSection === "overview") {
    return (
      <SearchOverview
        searchValue={searchValue}
        setSearchValue={setSearchValue}
        onSubmit={onSubmit}
        providerCapabilities={providerCapabilities}
        providerError={providerError}
      />
    );
  }

  if (activeSection === "wallets") {
    return <WalletProfilesList profiles={walletProfiles} openWallet={openWallet} deleteWallet={deleteWallet} />;
  }

  if (activeSection === "wallet") {
    return (
      <WalletProfileWorkspace
        address={address}
        profile={profile}
        rpcError={rpcError}
        networkCandidates={networkCandidates}
        watchEnabled={watchEnabled}
        setWatchEnabled={setWatchEnabled}
        addFeed={addFeed}
        refreshWallet={refreshWallet}
        activeWorkspaceId={activeWorkspaceId}
        saveWatchlistRule={saveWatchlistRule}
        setActiveSection={setActiveSection}
        selectNetworkCandidate={selectNetworkCandidate}
      />
    );
  }

  if (activeSection === "transactions") {
    return (
      <section className="mt-4">
        <TransactionsPanel address={address} onOpenAddress={openTransactions} profile={profile} />
      </section>
    );
  }

  if (activeSection === "trace") {
    return (
      <section className="mt-4">
        <FundTracePage
          address={address}
          profile={profile}
          activeWorkspaceId={activeWorkspaceId}
          saveWatchlistRule={saveWatchlistRule}
          watchlistRules={watchlistRules}
          addFeed={addFeed}
          restoredCase={restoredCase}
        />
      </section>
    );
  }

  if (activeSection === "graph") {
    return (
      <section className="mt-4">
        <TransactionGraph
          address={address}
          profile={profile}
          addFeed={addFeed}
          openWalletProfile={(nextAddress) => openWallet({ address: nextAddress })}
          restoredCase={restoredCase}
          activeWorkspaceId={activeWorkspaceId}
          saveWatchlistRule={saveWatchlistRule}
          />
      </section>
    );
  }

  if (activeSection === "alerts") {
    return (
      <section className="mt-4 grid gap-4">
        <div className="grid gap-4 xl:grid-cols-[430px_minmax(0,1fr)]">
          <TelegramAlerts
            enabled={telegramEnabled}
            setEnabled={setTelegramEnabled}
            feed={feed}
            addFeed={addFeed}
            address={address}
            networkName={profile.name}
            saveWatchlistRule={saveWatchlistRule}
            pollWatchlist={pollWatchlist}
          />
          <WatchlistPanel
            address={address}
            networkName={profile.name}
            addFeed={addFeed}
            rules={watchlistRules}
            alertEvents={alertEvents}
            removeRule={removeWatchlistRule}
            saveRule={saveWatchlistRule}
          />
        </div>
        <AlertEventsPanel events={alertEvents} />
      </section>
    );
  }

  if (activeSection === "api") {
    return <ProviderDiagnosticsPage providerCapabilities={providerCapabilities} providerError={providerError} />;
  }

  if (activeSection === "mixers") {
    return (
      <section className="overflow-safe mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <MixerExitAnalysis address={address} profile={profile} addFeed={addFeed} saveWatchlistRule={saveWatchlistRule} />
        <div className="overflow-safe grid content-start gap-4">
          <EntityLabelsPanel addFeed={addFeed} />
          <MixerRulesPanel />
        </div>
      </section>
    );
  }

  if (activeSection === "exchanges") {
    return (
      <section className="mt-4">
        <ExchangeAttributionPage address={address} addFeed={addFeed} openWallet={openWallet} />
      </section>
    );
  }

  if (activeSection === "sanctions") {
    return (
      <section className="mt-4">
        <SanctionsDatabasePage addFeed={addFeed} openWallet={openWallet} />
      </section>
    );
  }

  if (activeSection === "cases") {
    return (
      <section className="mt-4">
        <InvestigationsPanel activeWorkspaceId={activeWorkspaceId} activeWorkspaceName={activeWorkspaceName} openInvestigationCase={openInvestigationCase} />
      </section>
    );
  }

  if (activeSection === "audit") {
    return (
      <section className="mt-4">
        <AuditLogPanel />
      </section>
    );
  }

  return (
    <SearchOverview
      searchValue={searchValue}
      setSearchValue={setSearchValue}
      onSubmit={onSubmit}
      providerCapabilities={providerCapabilities}
      providerError={providerError}
    />
  );
}

function AuthScreen({ language, onAuthSuccess, setLanguage }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const payload = { username, password, displayName };
      const session = mode === "register" ? await registerUser(payload) : await loginUser(payload);
      onAuthSuccess(session);
    } catch (authError) {
      setError(authError.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-zinc-100">
      <img
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center"
        src={authBackground}
      />
      <div className="absolute inset-0 bg-black/50" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.82),rgba(0,0,0,0.42)_46%,rgba(0,0,0,0.18)),linear-gradient(180deg,rgba(0,0,0,0.08),rgba(0,0,0,0.78))]" />
      <div className="absolute right-4 top-4 z-20 grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-black/70 p-1 backdrop-blur">
        {[
          ["ru", "RU"],
          ["en", "EN"],
          ["kz", "KZ"],
        ].map(([value, label]) => (
          <button
            className={`min-h-8 min-w-10 rounded px-2 text-xs font-semibold transition ${
              language === value ? "bg-sentinel-green text-black" : "text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            }`}
            key={value}
            onClick={() => setLanguage(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <section className="relative z-10 grid min-h-screen place-items-center px-4 py-8">
        <div className="grid w-full max-w-[1040px] overflow-hidden rounded-lg bg-black/86 shadow-[0_34px_120px_rgba(0,0,0,0.92),0_0_0_1px_rgba(255,255,255,0.06)] backdrop-blur-2xl lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="relative hidden min-h-[600px] p-8 lg:block">
            <div className="absolute inset-0 bg-gradient-to-r from-black/35 to-black/80" />
            <div className="relative flex h-full flex-col justify-between">
              <div>
                <p className="text-base font-semibold text-zinc-100">ChainSentra</p>
                <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">AML workspace</p>
              </div>
              <div className="max-w-md">
                <p className="section-label">Monitor. Analyze. Protect.</p>
                <h1 className="mt-4 text-5xl font-semibold leading-tight text-zinc-50">
                  Рабочее место для on-chain расследований
                </h1>
                <p className="mt-5 text-sm leading-6 text-zinc-400">
                  Профили кошельков, графы связей, watchlist, Telegram alerts и диагностика API в одном интерфейсе.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                {["Wallets", "Graphs", "Alerts"].map((item) => (
                  <div className="rounded-md bg-white/[0.06] px-3 py-2 text-zinc-400" key={item}>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid min-h-[600px] content-center p-6 sm:p-8">
            <div className="mb-8 lg:hidden">
              <p className="text-base font-semibold text-zinc-100">ChainSentra</p>
              <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">AML workspace</p>
            </div>

            <div>
              <p className="section-label">{mode === "register" ? "Новый профиль" : "Доступ к системе"}</p>
              <h2 className="mt-2 text-2xl font-semibold text-zinc-50">
                {mode === "register" ? "Создать аккаунт" : "Войти в систему"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                {mode === "register"
                  ? "Создайте отдельное пространство для кошельков, кейсов и уведомлений."
                  : "Откройте свои кошельки, кейсы и правила мониторинга."}
              </p>
            </div>

            <div className="mt-6 grid grid-cols-2 rounded-md bg-white/[0.08] p-1">
            {[
              ["login", "Вход"],
              ["register", "Регистрация"],
            ].map(([key, label]) => (
              <button
                className={`min-h-10 rounded text-sm transition ${
                  mode === key
                    ? "bg-zinc-100 text-black"
                    : "text-zinc-500 hover:text-zinc-100"
                }`}
                key={key}
                onClick={() => {
                  setMode(key);
                  setError("");
                }}
                type="button"
              >
                {label}
              </button>
            ))}
            </div>

            <form className="mt-5 grid gap-3" onSubmit={submit}>
            <label className="grid gap-1 text-xs text-zinc-500">
              Login
              <input
                autoComplete="username"
                className="control min-h-11 border-white/15 bg-black/75"
                placeholder="jeweler"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            {mode === "register" ? (
              <label className="grid gap-1 text-xs text-zinc-500">
                Display name
                <input
                  autoComplete="name"
                  className="control min-h-11 border-white/15 bg-black/75"
                  placeholder="Workspace name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            ) : null}
            <label className="grid gap-1 text-xs text-zinc-500">
              Password
              <input
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                className="control min-h-11 border-white/15 bg-black/75"
                placeholder="••••••••"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? (
              <div className="rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">
                {error}
              </div>
            ) : null}
            <button className={`primary-button min-h-11 ${loading ? "button-loading" : ""}`} disabled={loading} type="submit">
              {loading ? <LoadingDots label="Проверяю" /> : mode === "register" ? "Создать аккаунт" : "Войти"}
            </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

function Sidebar({
  activeSection,
  authUser,
  collapsed,
  detectedNetwork,
  fontScale,
  language,
  logout,
  setActiveSection,
  setCollapsed,
  setFontScale,
  setLanguage,
  setTheme,
  theme,
  walletCount,
}) {
  const items = [
    { id: "trace", label: "Трассировка", icon: RouteIcon },
    { id: "overview", label: "Обзор", icon: LayoutDashboard },
    { id: "wallets", label: "Кошельки", icon: WalletCards },
    { id: "transactions", label: "Транзакции", icon: ListChecks },
    { id: "graph", label: "Граф", icon: Network },
    { id: "alerts", label: "Уведомления", icon: Bell },
    { id: "api", label: "API", icon: PlugZap },
    { id: "mixers", label: "Миксеры", icon: Shuffle },
    { id: "exchanges", label: "Биржи", icon: Building2 },
    { id: "sanctions", label: "Risk DB", icon: ShieldAlert },
    { id: "cases", label: "Расследования", icon: FolderOpen },
    { id: "audit", label: "Audit Log", icon: ScrollText },
  ];

  return (
    <aside className={`sticky top-0 h-screen border-r border-sentinel-line bg-black py-5 ${collapsed ? "px-3" : "px-4"} max-[760px]:static max-[760px]:h-auto max-[760px]:border-b max-[760px]:border-r-0 max-[760px]:px-4`}>
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between gap-3"} max-[760px]:justify-between`}>
        <div className={`min-w-0 ${collapsed ? "hidden" : "block"} max-[760px]:block`}>
          <div>
            <p className="font-semibold text-zinc-100">ChainSentra</p>
            <p className="text-xs text-zinc-500">financial monitoring</p>
          </div>
        </div>
        <button
          aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
          className="grid size-9 place-items-center rounded-md border border-zinc-800 bg-black text-zinc-500 hover:border-zinc-600 hover:text-zinc-100 max-[760px]:hidden"
          onClick={() => setCollapsed((current) => !current)}
          title={collapsed ? "Развернуть меню" : "Свернуть меню"}
          type="button"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <nav className="mt-7 grid gap-2 max-[760px]:mt-4 max-[760px]:grid-cols-4 max-[460px]:grid-cols-2">
        {items.map((item) => {
          const Icon = item.icon;

          return (
          <button
            className={`flex min-h-10 items-center rounded-md border text-sm transition ${
              collapsed ? "justify-center px-0" : "gap-3 px-3 text-left"
            } max-[760px]:justify-start max-[760px]:gap-2 max-[760px]:px-3 max-[760px]:text-left ${
              activeSection === item.id
                ? "border-zinc-600 bg-ink-850 text-zinc-100"
                : "border-transparent text-zinc-500 hover:border-sentinel-line hover:text-zinc-300"
            }`}
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            title={item.label}
            type="button"
          >
            <Icon className="size-4 shrink-0" />
            <span className={`${collapsed ? "hidden" : ""} max-[760px]:inline`}>{item.label}</span>
          </button>
          );
        })}
      </nav>

      <div className={`${collapsed ? "hidden" : "panel-subtle"} mt-7 p-3 max-[760px]:hidden`}>
        <p className="text-xs text-zinc-500">Аккаунт</p>
        <p className="mt-1 truncate text-sm font-semibold text-zinc-100">{authUser.displayName || authUser.username}</p>
        <p className="mt-1 truncate text-xs text-zinc-600">{authUser.username}</p>
        <p className="mt-3 text-sm font-semibold text-zinc-100">{walletCount} адресов</p>
        <p className="mt-3 text-xs text-zinc-500">Текущая сеть: {detectedNetwork}</p>
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <span className="size-2 rounded-full bg-sentinel-green" />
          Authorized
        </div>
        <button
          className="ghost-button mt-4 flex min-h-8 w-full items-center justify-center gap-2 text-xs"
          onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          type="button"
        >
          {theme === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}
          {theme === "light" ? "Тёмная тема" : "Светлая тема"}
        </button>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-zinc-800 bg-black p-1">
          {[
            ["ru", "RU"],
            ["en", "EN"],
            ["kz", "KZ"],
          ].map(([value, label]) => (
            <button
              className={`min-h-8 rounded text-xs font-semibold transition ${
                language === value ? "bg-sentinel-green text-black" : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-100"
              }`}
              key={value}
              onClick={() => setLanguage(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-zinc-800 bg-black p-1">
          {[
            ["compact", "A-"],
            ["normal", "A"],
            ["large", "A+"],
          ].map(([value, label]) => (
            <button
              className={`min-h-8 rounded text-xs font-semibold transition ${
                fontScale === value ? "bg-sentinel-green text-black" : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-100"
              }`}
              key={value}
              onClick={() => setFontScale(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button className="ghost-button mt-2 min-h-8 w-full text-xs" onClick={logout} type="button">
          Выйти
        </button>
      </div>
    </aside>
  );
}

function Header({ searchValue, setSearchValue, onSubmit }) {
  return (
    <header className="grid gap-3">
      <form className="w-full max-w-4xl" onSubmit={onSubmit}>
        <label className="section-label" htmlFor="address-search">
          Универсальный поиск адреса, tx hash или кластера
        </label>
        <div className="mt-2 grid min-h-11 grid-cols-[minmax(0,1fr)_auto] rounded-lg border border-sentinel-line bg-black">
          <input
            aria-label="Универсальный поиск адреса, tx hash или кластера"
            id="address-search"
            className="min-w-0 bg-transparent px-3 text-sm text-zinc-100 outline-none"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
          />
          <button className="primary-button m-1 min-h-9" type="submit">
            Проверить
          </button>
        </div>
      </form>
    </header>
  );
}

function SearchOverview({ providerCapabilities, providerError, searchValue, setSearchValue, onSubmit }) {
  const providerTasks = providerCapabilities?.tasks
    ? Object.entries(providerCapabilities.tasks).map(([key, task]) => {
        const providers = task.providers || [];
        const configured = providers.filter((provider) => provider.configured || provider.keyConfigured).length;
        const networks = new Set(providers.flatMap((provider) => provider.networks || []));

        return {
          key,
          configured,
          total: providers.length,
          networkCount: networks.size,
        };
      })
    : [];
  const providerHealth = Object.values(providerCapabilities?.health || {});
  const providerHealthCalls = providerHealth.reduce((sum, item) => sum + Number(item.calls || 0), 0);
  const providerHealthErrors = providerHealth.reduce((sum, item) => sum + Number(item.errorCalls || 0), 0);

  return (
    <section className="grid min-h-[calc(100vh-32px)] place-items-center">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <p className="section-label">ChainSentra</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-normal text-zinc-50 max-[640px]:text-3xl">
            Поиск профиля кошелька
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500">
            Введите адрес один раз. Система создаст сохраненный профиль с отдельной ссылкой,
            чтобы не выполнять один и тот же поиск повторно.
          </p>
        </div>

        <form className="panel p-4" onSubmit={onSubmit}>
          <label className="section-label" htmlFor="overview-address-search">
            Адрес кошелька
          </label>
          <div className="mt-3 grid min-h-14 grid-cols-[minmax(0,1fr)_132px] rounded-lg border border-sentinel-line bg-black max-[560px]:grid-cols-1">
            <input
              aria-label="Адрес кошелька"
              id="overview-address-search"
              className="min-w-0 bg-transparent px-4 text-base text-zinc-100 outline-none"
              placeholder="0x..., bc1..., T..., Solana..."
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
            />
            <button className="primary-button m-1 min-h-12" type="submit">
              Поиск
            </button>
          </div>
        </form>

        <div className="mt-4 rounded-lg border border-zinc-900 bg-black p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="section-label">API coverage</p>
              <p className="mt-1 text-sm text-zinc-500">
                {providerError || (providerCapabilities ? "Live provider configuration" : "Loading provider status")}
              </p>
              {providerHealthCalls ? (
                <p className="mt-1 text-xs text-zinc-600">
                  24h telemetry: {providerHealthCalls} calls · {providerHealthErrors} errors
                </p>
              ) : null}
              {providerCapabilities?.dataPolicy?.demoDataEnabled === false ? (
                <p className="mt-2 text-xs font-medium text-sentinel-green">
                  Демо-данные отключены · используются только live API, реальный кэш и проверенные импорты
                </p>
              ) : null}
            </div>
            <span className={`size-2 rounded-full ${providerError ? "bg-red-400" : providerCapabilities ? "bg-sentinel-green" : "bg-zinc-700"}`} />
          </div>

          {providerTasks.length ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {providerTasks.map((task) => (
                <div className="rounded-md border border-zinc-900 bg-ink-950 px-3 py-2" key={task.key}>
                  <p className="text-xs font-semibold uppercase text-zinc-300">{task.key.replace(/[A-Z]/g, (match) => ` ${match}`).trim()}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {task.configured}/{task.total} sources · {task.networkCount} networks
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function readableTaskName(key) {
  const names = {
    attribution: "Атрибуция",
    bitcoinTransactions: "Bitcoin транзакции",
    evmLiveSnapshot: "EVM live snapshot",
    evmNftExposure: "EVM NFT exposure",
    evmTokenBalances: "EVM token balances",
    evmTransactions: "EVM транзакции",
    tronTransactions: "TRON транзакции",
  };

  return names[key] || key.replace(/[A-Z]/g, (match) => ` ${match}`).trim();
}

function providerStatus(provider, health) {
  if (!provider.configured && !provider.keyConfigured) {
    return "не настроен";
  }

  const stats = health?.[provider.name];

  if (!stats?.calls) {
    return "готов";
  }

  return Number(stats.errorCalls || 0) ? "есть ошибки" : "работает";
}

function providerStatusClass(status) {
  if (status === "работает" || status === "готов") {
    return "border-sentinel-green/40 text-sentinel-green";
  }
  if (status === "есть ошибки") {
    return "border-sentinel-warning/40 text-sentinel-warning";
  }
  return "border-zinc-700 text-zinc-500";
}

function ProviderDiagnosticsPage({ providerCapabilities, providerError }) {
  const tasks = providerCapabilities?.tasks || {};
  const health = providerCapabilities?.health || {};
  const rows = Object.entries(tasks).flatMap(([taskKey, task]) =>
    (task.providers || []).map((provider) => ({
      taskKey,
      taskName: readableTaskName(taskKey),
      provider,
      health: health[provider.name] || null,
      status: providerStatus(provider, health),
    }))
  );
  const totalCalls = Object.values(health).reduce((sum, item) => sum + Number(item.calls || 0), 0);
  const totalErrors = Object.values(health).reduce((sum, item) => sum + Number(item.errorCalls || 0), 0);
  const configured = rows.filter((row) => row.provider.configured || row.provider.keyConfigured).length;

  return (
    <section className="mt-4 grid gap-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label">Provider diagnostics</p>
            <h1 className="mt-1 text-xl font-semibold text-zinc-100">API покрытие и здоровье</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
              Здесь видно, какие API используются для каждой задачи, какие сети покрыты, где есть ключи,
              и какие провайдеры недавно отдавали ошибки.
            </p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs ${providerError ? "border-sentinel-danger/40 text-sentinel-danger" : "border-sentinel-green/40 text-sentinel-green"}`}>
            {providerError || "providers loaded"}
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {[
            ["Задачи", Object.keys(tasks).length],
            ["Sources", rows.length],
            ["Configured", configured],
            ["24h errors", totalErrors],
          ].map(([label, value]) => (
            <div className="rounded-md border border-zinc-800 bg-black px-3 py-2" key={label}>
              <p className="text-xs text-zinc-600">{label}</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
            </div>
          ))}
        </div>
        {totalCalls ? <p className="mt-3 text-xs text-zinc-600">24h telemetry: {totalCalls} calls · {totalErrors} errors</p> : null}
      </section>

      <section className="panel p-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="py-3 pr-3 font-medium">Задача</th>
                <th className="py-3 pr-3 font-medium">Provider</th>
                <th className="py-3 pr-3 font-medium">Статус</th>
                <th className="py-3 pr-3 font-medium">Networks</th>
                <th className="py-3 pr-3 font-medium">Uses</th>
                <th className="py-3 pr-3 font-medium">24h calls</th>
                <th className="py-3 pr-3 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-zinc-900 last:border-b-0" key={`${row.taskKey}-${row.provider.name}`}>
                  <td className="py-3 pr-3 font-semibold text-zinc-200">{row.taskName}</td>
                  <td className="py-3 pr-3 text-zinc-400">{row.provider.name}</td>
                  <td className="py-3 pr-3">
                    <span className={`rounded-full border px-2 py-1 text-xs ${providerStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                    {row.provider.keyConfigured === false && row.provider.configured ? (
                      <div className="mt-1 text-xs text-sentinel-warning">работает без API key</div>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-zinc-500">
                    {(row.provider.networks || []).slice(0, 8).join(", ")}
                    {(row.provider.networks || []).length > 8 ? ` +${row.provider.networks.length - 8}` : ""}
                  </td>
                  <td className="py-3 pr-3 text-zinc-500">{(row.provider.uses || []).join(" · ")}</td>
                  <td className="py-3 pr-3 text-zinc-500">
                    {row.health?.calls ? `${row.health.calls} / errors ${row.health.errorCalls}` : "no calls"}
                    {row.health?.successRate !== null && row.health?.successRate !== undefined ? (
                      <div className="mt-1 text-xs text-zinc-600">success {Math.round(row.health.successRate * 100)}%</div>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-sentinel-warning">
                    {row.health?.lastError || "none"}
                    {row.health?.lastSeenAt ? <div className="mt-1 text-xs text-zinc-600">{new Date(row.health.lastSeenAt).toLocaleString("ru-RU")}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
              Provider status еще не загружен.
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}

function arkhamEntityCategory(entity) {
  const text = `${entity?.type || ""} ${entity?.name || ""}`.toLowerCase();
  if (/(mixer|tornado|privacy|coinjoin|launder)/.test(text)) return "mixer";
  if (/(exchange|cex|dex|binance|coinbase|kraken|okx|bybit)/.test(text)) return "exchange";
  if (/(bridge|cross-chain|cross chain)/.test(text)) return "bridge";
  if (/(scam|phish|exploit|hack|ransom|sanction|drainer)/.test(text)) return "scam";
  return "service";
}

function pickWalletEntity(intelligence) {
  const entity = intelligence?.entities?.find((item) => item?.name) || null;
  if (!entity) {
    return null;
  }
  const rawConfidence = Number(entity.confidence || 0);
  const confidence = rawConfidence > 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;

  return {
    category: arkhamEntityCategory(entity),
    confidence: Math.min(100, Math.max(1, confidence ? Math.round(confidence) : 92)),
    name: String(entity.name || "Known entity").trim(),
    type: String(entity.type || "").trim(),
  };
}

function WalletProfileWorkspace({
  address,
  profile,
  rpcError,
  networkCandidates: _networkCandidates,
  watchEnabled,
  setWatchEnabled,
  addFeed,
  refreshWallet,
  activeWorkspaceId,
  saveWatchlistRule,
  setActiveSection,
  selectNetworkCandidate: _selectNetworkCandidate,
}) {
  const [riskAnalysis, setRiskAnalysis] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState("");
  const [evmTokenData, setEvmTokenData] = useState(null);
  const [evmTokenLoading, setEvmTokenLoading] = useState(false);
  const [evmTokenError, setEvmTokenError] = useState("");
  const [evmNftData, setEvmNftData] = useState(null);
  const [evmNftLoading, setEvmNftLoading] = useState(false);
  const [evmNftError, setEvmNftError] = useState("");
  const [arkhamIntelligence, setArkhamIntelligence] = useState(null);
  const [arkhamLoading, setArkhamLoading] = useState(false);
  const [arkhamError, setArkhamError] = useState("");
  const [addressEntity, setAddressEntity] = useState(null);
  const addFeedRef = useRef(addFeed);
  const isEvmProfile = /^0x[a-fA-F0-9]{40}$/.test(address);
  const riskNetworkKey = isEvmProfile && profile.networkKey !== "TRX" ? "ALL" : profile.networkKey;
  const tokenNetworkKey = isEvmProfile ? "ALL" : profile.networkKey;

  useEffect(() => {
    addFeedRef.current = addFeed;
  }, [addFeed]);

  useEffect(() => {
    if (!address) {
      setRiskAnalysis(null);
      setRiskError("");
      return;
    }

    let cancelled = false;
    setRiskLoading(true);
    setRiskError("");

    getWalletRisk({ address, networkKey: riskNetworkKey, mode: "fast" })
      .then((result) => {
        if (!cancelled) {
          setRiskAnalysis(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRiskAnalysis(null);
          setRiskError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRiskLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, riskNetworkKey]);

  useEffect(() => {
    if (!address || profile.networkKey === "TRX" || !isEvmProfile) {
      setEvmTokenData(null);
      setEvmTokenError("");
      setEvmTokenLoading(false);
      setEvmNftData(null);
      setEvmNftError("");
      setEvmNftLoading(false);
      return;
    }

    let cancelled = false;
    setEvmTokenLoading(true);
    setEvmTokenError("");
    setEvmNftLoading(true);
    setEvmNftError("");

    getWalletTokens({ address, networkKey: tokenNetworkKey, limit: 40 })
      .then((result) => {
        if (!cancelled) {
          setEvmTokenData(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEvmTokenData(null);
          setEvmTokenError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEvmTokenLoading(false);
        }
      });

    getWalletNfts({ address, networkKey: tokenNetworkKey, limit: 24 })
      .then((result) => {
        if (!cancelled) {
          setEvmNftData(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEvmNftData(null);
          setEvmNftError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEvmNftLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, isEvmProfile, profile.networkKey, tokenNetworkKey]);

  useEffect(() => {
    if (!address || !isEvmProfile) {
      setArkhamIntelligence(null);
      setArkhamError("");
      setArkhamLoading(false);
      setAddressEntity(null);
      return;
    }

    let cancelled = false;
    setArkhamLoading(true);
    setArkhamError("");
    setArkhamIntelligence(null);
    setAddressEntity(null);

    getArkhamAddressIntelligence(address)
      .then(async (result) => {
        if (cancelled) {
          return;
        }

        setArkhamIntelligence(result);
        const entity = pickWalletEntity(result);
        setAddressEntity(entity);

        if (entity) {
          try {
            await upsertEntityLabel({
              address,
              networkKey: "ALL",
              category: entity.category,
              name: entity.name,
              confidence: entity.confidence,
              source: "arkham-auto",
              notes: entity.type ? `Arkham entity type: ${entity.type}` : "Arkham entity enrichment",
            });
            if (!cancelled) {
              setAddressEntity({ ...entity, saved: true });
              addFeedRef.current?.(`${shortAddress(address)}: entity saved · ${entity.name}`);
              setRiskLoading(true);
              setRiskError("");
              try {
                const refreshedRisk = await getWalletRisk({ address, networkKey: riskNetworkKey, mode: "fast", refresh: true });
                if (!cancelled) {
                  setRiskAnalysis(refreshedRisk);
                }
              } catch (riskRefreshError) {
                if (!cancelled) {
                  setRiskError(riskRefreshError.message);
                }
              } finally {
                if (!cancelled) {
                  setRiskLoading(false);
                }
              }
            }
          } catch (saveError) {
            if (!cancelled) {
              setAddressEntity({ ...entity, saved: false, saveError: saveError.message });
            }
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setArkhamIntelligence(null);
          setAddressEntity(null);
          setArkhamError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setArkhamLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, isEvmProfile, riskNetworkKey]);

  return (
    <section className="mt-4 grid gap-4 2xl:grid-cols-[minmax(0,1fr)_360px]">
      <main className="grid content-start gap-4">
        <WalletProfileHeader
          address={address}
          addressEntity={addressEntity}
          arkhamError={arkhamError}
          arkhamIntelligence={arkhamIntelligence}
          arkhamLoading={arkhamLoading}
          profile={profile}
          riskAnalysis={riskAnalysis}
          riskError={riskError}
          riskLoading={riskLoading}
          tokenData={evmTokenData}
          tokenError={evmTokenError}
          tokenLoading={evmTokenLoading}
          nftData={evmNftData}
          nftError={evmNftError}
          nftLoading={evmNftLoading}
        />
        <MetricGrid profile={profile} />
        <ProfileInvestigationSummary profile={profile} />
      </main>

      <aside className="grid content-start gap-4 2xl:sticky 2xl:top-4">
        <ProfileActionsPanel
          address={address}
          profile={profile}
          watchEnabled={watchEnabled}
          setWatchEnabled={setWatchEnabled}
          addFeed={addFeed}
          refreshWallet={refreshWallet}
          activeWorkspaceId={activeWorkspaceId}
          saveWatchlistRule={saveWatchlistRule}
          setActiveSection={setActiveSection}
        />
        <ProviderCoveragePanel profile={profile} rpcError={rpcError} />
        <WalletProviderReport
          address={address}
          nftData={evmNftData}
          nftError={evmNftError}
          nftLoading={evmNftLoading}
          profile={profile}
          rpcError={rpcError}
          riskAnalysis={riskAnalysis}
          riskError={riskError}
          riskLoading={riskLoading}
          tokenData={evmTokenData}
          tokenError={evmTokenError}
          tokenLoading={evmTokenLoading}
        />
      </aside>
    </section>
  );
}

function WalletProfileHeader(props) {
  const {
    address,
    addressEntity,
    arkhamError,
    arkhamIntelligence,
    arkhamLoading,
    profile,
    riskAnalysis,
    riskError,
    riskLoading,
    tokenData,
    tokenError,
    tokenLoading,
    nftData,
    nftError,
    nftLoading,
  } = props;
  const link = walletPath(address);
  const score = riskAnalysis?.riskScore ?? profile.risk;
  const level = riskAnalysis?.riskLevel || (score >= 70 ? "high" : score >= 45 ? "medium" : "low");
  const riskTone =
    level === "critical" || level === "high"
      ? "border-sentinel-danger/50 text-sentinel-danger"
      : level === "medium"
        ? "border-sentinel-warning/50 text-sentinel-warning"
        : "border-sentinel-green/50 text-sentinel-green";
  const topFactors = riskAnalysis?.riskFactors?.slice(0, 2) || [];
  const coverage = riskAnalysis?.coverage || {};
  const visibleNetworks = profile.networkCandidates?.length
    ? uniqueNetworkCandidates(profile.networkCandidates)
    : [
        {
          networkKey: profile.networkKey,
          networkName: profile.name,
          balance: profile.balance || "not loaded",
          symbol: profile.symbol || "",
          txCount: profile.tx,
        },
      ];
  const isMultichainEvm = /^0x[a-fA-F0-9]{40}$/.test(address) && visibleNetworks.length > 1;
  const profileFacts = [
    ["Создан", profile.accountCreatedAt ? new Date(profile.accountCreatedAt).toLocaleDateString("ru-RU") : "Нет данных от источника"],
    ["Последняя активность", profile.latestActivityAt ? new Date(profile.latestActivityAt).toLocaleDateString("ru-RU") : "Нет данных от источника"],
  ];

  return (
    <section className="panel soft-enter p-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_180px]">
        <div className="min-w-0">
          <p className="section-label">Wallet profile</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal text-zinc-100 max-[640px]:text-2xl">
            {isMultichainEvm ? "EVM address profile" : `${profile.name} wallet`}
          </h1>
          {addressEntity ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded border border-sentinel-cyan/40 bg-sentinel-cyan/10 px-2.5 py-1 text-xs font-semibold text-sentinel-cyan">
                Entity: {addressEntity.name}
              </span>
              {addressEntity.type ? (
                <span className="rounded border border-zinc-800 bg-black px-2.5 py-1 text-xs text-zinc-400">
                  {addressEntity.type}
                </span>
              ) : null}
              <span className="rounded border border-zinc-800 bg-black px-2.5 py-1 text-xs text-zinc-500">
                {addressEntity.saved ? "saved to local labels" : addressEntity.saveError ? "save failed" : "detected by Arkham"}
              </span>
            </div>
          ) : arkhamLoading && isMultichainEvm ? (
            <p className="mt-3 text-xs text-zinc-500">
              <LoadingDots label="Проверяю entity attribution" />
            </p>
          ) : null}
          <p className="mt-3 break-all text-base font-semibold text-zinc-100">{address}</p>
          <a className="mt-3 block break-all text-xs text-zinc-600 hover:text-zinc-300" href={link}>
            {link}
          </a>
        </div>

        <div className={`grid place-items-center rounded-lg border bg-black p-4 ${riskTone} ${riskLoading ? "loading-scan" : ""}`}>
          <div className="text-center">
            <p className="text-5xl font-bold">{riskLoading ? <LoadingDots label="" /> : score}</p>
            <p className="mt-1 text-xs uppercase tracking-[0.08em] text-zinc-500">
              {riskAnalysis ? `${level} risk` : "risk score"}
            </p>
            {riskAnalysis ? (
              <p className="mt-2 text-[11px] text-zinc-600">confidence {riskAnalysis.confidence}%</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-zinc-800 bg-black">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(150px,auto)] gap-3 border-b border-zinc-900 px-3 py-2 text-[11px] text-zinc-500">
          <span>Сеть</span>
          <span className="text-right">Баланс / Tx count</span>
        </div>
        <div className="divide-y divide-zinc-900">
          {visibleNetworks.slice(0, 12).map((candidate) => {
            return (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(150px,auto)] items-center gap-3 px-3 py-2" key={`${candidate.networkKey}-${candidate.networkName}`}>
              <div className="flex min-w-0 items-center gap-2">
                <NetworkIcon networkKey={candidate.networkKey} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-100">{candidate.networkName}</p>
                  <p className="text-[10px] text-zinc-600">{candidate.networkKey}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold text-zinc-100">
                  {candidate.balance} {candidate.symbol}
                </p>
                <p className="text-[10px] text-zinc-500">tx count: {candidate.txCount}</p>
              </div>
            </div>
            );
          })}
        </div>
      </div>

      <dl className="mt-5 divide-y divide-zinc-900 border-y border-zinc-900">
        {profileFacts.map(([label, value]) => (
          <div className="grid grid-cols-[170px_minmax(0,1fr)] gap-4 py-3 max-[560px]:grid-cols-1 max-[560px]:gap-1" key={label}>
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="break-words text-sm font-semibold text-zinc-100">{value}</dd>
          </div>
        ))}
      </dl>

      {profile.networkKey === "TRX" ? (
        <TokenHoldings
          emptyText="В ответе TronGrid для этого адреса не найдено TRC10/TRC20 балансов кроме native TRX."
          title="TRON token holdings"
          tokens={profile.tokens}
        />
      ) : /^0x[a-fA-F0-9]{40}$/.test(address) ? (
        <>
          <TokenHoldings
            emptyText={tokenData?.providerRequired ? tokenData.message : "Alchemy не нашёл ERC-20 балансы для этого адреса."}
            error={tokenError}
            loading={tokenLoading}
            meta={tokenData?.provider ? `${tokenData.provider} · ${tokenData.networkName || profile.name}` : "Alchemy Token API"}
            providerErrors={[...(tokenData?.warnings || []), ...(tokenData?.errors || [])]}
            stats={
              tokenData
                ? [
                    ["Всего contracts", tokenData.totalTokenCount ?? 0],
                    ["Non-zero", tokenData.nonZeroTokenCount ?? 0],
                    ["Shown", tokenData.shownTokenCount ?? tokenData.tokens?.length ?? 0],
                    ["Networks", tokenData.checkedNetworks?.length ?? 1],
                  ]
                : []
            }
            title="EVM token holdings"
            tokens={tokenData?.tokens || []}
          />
          <NftExposure
            data={nftData}
            emptyText={nftData?.providerRequired ? nftData.message : "Alchemy не нашёл NFT exposure для этого адреса."}
            error={nftError}
            loading={nftLoading}
          />
        </>
      ) : null}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label">Aggregated AML score</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">
              {riskLoading ? <LoadingDots label="Считаю риск по API" /> : riskAnalysis?.explanation?.summary || "Ожидание risk analysis"}
            </p>
          </div>
          {riskAnalysis ? (
            <span className={`rounded border px-3 py-1 text-xs font-semibold ${riskTone}`}>
              {riskAnalysis.riskScore} · {riskAnalysis.riskLevel}{riskAnalysis.cacheHit ? " · cached" : ""}
            </span>
          ) : null}
        </div>

        {riskError ? (
          <p className="mt-3 rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-2 text-xs text-sentinel-danger">
            Risk API error: {riskError}
          </p>
        ) : null}

        {riskLoading && !riskAnalysis ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {[0, 1].map((item) => (
              <article className="rounded-md border border-zinc-800 bg-ink-950 p-3" key={item}>
                <SkeletonBlock lines={2} />
              </article>
            ))}
          </div>
        ) : riskAnalysis ? (
          <>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              {[
                ["Tx", coverage.transactions],
                ["Graph", coverage.graph],
                ["Arkham", coverage.arkham],
                ["Labels", coverage.entityLabels],
                ["Watchlist", coverage.watchlist],
                ["Cases", coverage.cases],
              ].map(([label, active]) => (
                <span
                  className={`rounded border px-2 py-1 ${
                    active ? "border-sentinel-green/40 text-sentinel-green" : "border-zinc-800 text-zinc-600"
                  }`}
                  key={label}
                >
                  {label}
                </span>
              ))}
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {topFactors.length ? topFactors.map((factor, index) => (
                <article className="rounded-md border border-zinc-800 bg-ink-950 p-3" key={`${factor.type}-${index}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold text-zinc-200">{factor.title}</p>
                    <span className="text-xs text-sentinel-warning">+{factor.points}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-zinc-500">{factor.description}</p>
                </article>
              )) : (
                <p className="rounded-md border border-zinc-800 bg-ink-950 p-3 text-xs text-zinc-500 md:col-span-2">
                  Сильных risk-факторов по доступным источникам не найдено.
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>

      <ArkhamIntelligencePanel address={address} error={arkhamError} intelligence={arkhamIntelligence} loading={arkhamLoading} />
    </section>
  );
}


function ProfileInvestigationSummary({ profile }) {
  const items = [
    ["Полная история", "вынесена во вкладку «Транзакции» с фильтрами по сети и риск-метками"],
    ["Граф связей", "строится отдельно по загруженной истории и не перегружает профиль"],
    ["Exit-address", "кандидаты считаются по быстрым выходам, близости суммы и временному окну"],
  ];

  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Investigation workspace</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Следующие проверки</h2>
        </div>
        <span className="rounded border border-zinc-700 bg-black px-3 py-1 text-xs text-zinc-500">{profile.name}</span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {items.map(([title, text]) => (
          <article className="rounded-lg border border-zinc-800 bg-black p-4" key={title}>
            <p className="text-sm font-semibold text-zinc-200">{title}</p>
            <p className="mt-2 text-xs leading-5 text-zinc-500">{text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TokenHoldings(props) {
  const { emptyText, error = "", loading = false, meta = "", providerErrors = [], stats = [], title, tokens = [] } = props;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="section-label">{title}</p>
        <span className="text-xs text-zinc-600">{loading ? <LoadingDots label="loading" /> : `${tokens.length} tokens`}</span>
      </div>
      {meta ? <p className="mt-1 text-xs text-zinc-600">{meta}</p> : null}
      {stats.length ? (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
          {stats.map(([label, value]) => (
            <span className="rounded border border-zinc-800 bg-black px-2 py-1" key={label}>
              {label}: <span className="text-zinc-300">{value}</span>
            </span>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 border-y border-sentinel-danger/30 py-3 text-sm text-sentinel-danger">
          Token API error: {error}
        </p>
      ) : null}
      {providerErrors.length ? (
        <details className="mt-2 rounded-md border border-sentinel-warning/30 bg-sentinel-warning/10 p-2 text-xs leading-5 text-sentinel-warning">
          <summary className="cursor-pointer list-none">
            Provider warnings: {providerErrors.length}
          </summary>
          <p className="mt-2 text-sentinel-warning/80">{providerErrors.slice(0, 8).join(" | ")}</p>
        </details>
      ) : null}

      {!error && loading && !tokens.length ? (
        <div className="mt-2 grid gap-2 border-y border-zinc-900 py-3">
          {[0, 1, 2].map((item) => (
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-4" key={item}>
              <SkeletonBlock lines={2} />
              <div className="skeleton-line h-4 self-center" />
            </div>
          ))}
        </div>
      ) : !error && tokens.length ? (
        <details className="soft-enter mt-2 rounded-md border border-zinc-900 bg-black">
          <summary className="cursor-pointer list-none px-3 py-3 text-sm font-semibold text-zinc-200">
            Показать список токенов ({tokens.length})
          </summary>
          <div className="divide-y divide-zinc-900 border-t border-zinc-900 px-3">
            {tokens.map((token) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_minmax(120px,auto)] gap-4 py-3 max-[560px]:grid-cols-1 max-[560px]:gap-1"
                key={`${token.tokenType}-${token.key}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-100">{token.symbol || "Token"}</p>
                  <p className="mt-1 truncate text-xs text-zinc-600">
                    {token.name || token.tokenType || "Token"}
                    {token.contractAddress ? ` · ${shortAddress(token.contractAddress)}` : ""}
                  </p>
                </div>
                <p className="text-right text-sm font-semibold text-zinc-100 max-[560px]:text-left">
                  {token.balance} {token.symbol || ""}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : !error ? (
        <p className="mt-2 border-y border-zinc-900 py-3 text-sm text-zinc-500">
          {loading ? <LoadingDots label="Загружаю токены" /> : emptyText}
        </p>
      ) : null}
    </div>
  );
}

function NftExposure({ data, emptyText, error = "", loading = false }) {
  const nfts = data?.nfts || [];

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="section-label">NFT exposure</p>
        <span className="text-xs text-zinc-600">{loading ? <LoadingDots label="loading" /> : `${nfts.length} NFTs`}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        {data?.provider ? `${data.provider} · ${data.networkName}` : "Alchemy NFT API"}
      </p>
      {data ? (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
          {[
            ["Total", data.totalCount ?? 0],
            ["Shown", data.shownCount ?? nfts.length],
            ["Spam", data.spamCount ?? 0],
            ["Networks", data.checkedNetworks?.length ?? 1],
          ].map(([label, value]) => (
            <span className="rounded border border-zinc-800 bg-black px-2 py-1" key={label}>
              {label}: <span className="text-zinc-300">{value}</span>
            </span>
          ))}
        </div>
      ) : null}
      {data?.warnings?.length ? (
        <details className="mt-2 rounded-md border border-sentinel-warning/30 bg-sentinel-warning/10 p-2 text-xs leading-5 text-sentinel-warning">
          <summary className="cursor-pointer list-none">
            NFT provider warnings: {data.warnings.length}
          </summary>
          <p className="mt-2 text-sentinel-warning/80">{data.warnings.slice(0, 8).join(" | ")}</p>
        </details>
      ) : null}
      {error ? (
        <p className="mt-2 border-y border-sentinel-danger/30 py-3 text-sm text-sentinel-danger">
          NFT API error: {error}
        </p>
      ) : null}
      {!error && loading && !nfts.length ? (
        <div className="mt-2 grid gap-2 border-y border-zinc-900 py-3">
          {[0, 1, 2].map((item) => (
            <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-3" key={item}>
              <div className="skeleton-line size-12 rounded-md" />
              <SkeletonBlock lines={2} />
            </div>
          ))}
        </div>
      ) : !error && nfts.length ? (
        <div className="soft-enter mt-2 grid grid-cols-2 gap-2 border-y border-zinc-900 py-3 max-[560px]:grid-cols-1">
          {nfts.slice(0, 8).map((nft) => (
            <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] gap-3 rounded-md border border-zinc-900 bg-black p-2" key={nft.key}>
              {nft.imageUrl ? (
                <img alt="" className="size-10 rounded bg-ink-900 object-cover" loading="lazy" src={nft.imageUrl} />
              ) : (
                <div className="grid size-10 place-items-center rounded bg-ink-900 text-xs font-semibold text-zinc-500">NFT</div>
              )}
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-zinc-100">{nft.name}</p>
                <p className="mt-1 truncate text-[11px] text-zinc-600">
                  {nft.collectionName || nft.tokenType}
                  {nft.isSpam ? " · spam" : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : !error ? (
        <p className="mt-2 border-y border-zinc-900 py-3 text-sm text-zinc-500">
          {loading ? <LoadingDots label="Загружаю NFT" /> : emptyText}
        </p>
      ) : null}
    </div>
  );
}

function ProfileActionsPanel({ address, profile, watchEnabled, setWatchEnabled, addFeed, refreshWallet, activeWorkspaceId, saveWatchlistRule, setActiveSection }) {
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");

  const runAction = async (key, action) => {
    if (!address || busyAction) {
      return;
    }

    setBusyAction(key);
    setActionError("");

    try {
      await action();
    } catch (error) {
      const message = error.message || "Action failed";
      setActionError(message);
      addFeed(`${address}: action error - ${message}`);
    } finally {
      setBusyAction("");
    }
  };

  const addToWatchlist = () =>
    runAction("watchlist", async () => {
      const rule = await saveWatchlistRule({
        address,
        networkName: profile.name,
        eventType: "Любое движение",
        amountLimit: "any",
        channel: "wallet-actions",
        active: true,
      });
      setWatchEnabled(true);
      addFeed(`${rule.address}: добавлено правило watchlist`);
      setActiveSection?.("alerts");
    });

  const createCase = () =>
    runAction("case", async () => {
      const savedCase = await upsertInvestigationCase({
        title: `${profile.name} ${shortAddress(address)}`,
        rootAddress: address,
        networkKey: profile.networkKey,
        profileId: activeWorkspaceId,
        severity: "Medium",
        status: "open",
        summary: {
          source: "wallet-actions",
          balance: profile.balance || null,
          symbol: profile.symbol || null,
          txCount: profile.tx || "0",
        },
      }, activeWorkspaceId);
      addFeed(`Кейс создан: ${savedCase.title}`);
      setActiveSection?.("cases");
    });

  const openMixerAnalysis = () => {
    addFeed(`${address}: открыт mixer-flow анализ`);
    setActiveSection?.("mixers");
  };

  return (
    <section className="panel p-4">
      <p className="section-label">Actions</p>
      <h2 className="mt-1 text-lg font-semibold text-zinc-100">Действия</h2>
      <div className="mt-4 grid gap-2">
        <button className={`primary-button min-h-10 ${busyAction === "refresh" ? "button-loading" : ""}`} disabled={Boolean(busyAction)} onClick={() => runAction("refresh", refreshWallet)} type="button">
          {busyAction === "refresh" ? <LoadingDots label="Обновляю" /> : "Обновить через API"}
        </button>
        <button
          className="ghost-button min-h-10"
          disabled={Boolean(busyAction)}
          onClick={addToWatchlist}
          type="button"
        >
          {busyAction === "watchlist" ? <LoadingDots label="Сохраняю" /> : watchEnabled ? "Watchlist сохранен" : "Добавить в watchlist"}
        </button>
        <button className="ghost-button min-h-10" disabled={Boolean(busyAction)} onClick={createCase} type="button">
          {busyAction === "case" ? <LoadingDots label="Создаю" /> : "Создать кейс"}
        </button>
        <button className="ghost-button min-h-10" disabled={Boolean(busyAction)} onClick={openMixerAnalysis} type="button">
          Проверить миксер
        </button>
      </div>
      {actionError ? <p className="mt-3 text-xs text-sentinel-danger">{actionError}</p> : null}
    </section>
  );
}

function WalletProfilesList({ profiles, openWallet, deleteWallet }) {
  return (
    <section className="mt-4 panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Saved wallets</p>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Список адресов</h1>
        </div>
        <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-500">
          {profiles.length}
        </span>
      </div>

      {profiles.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="py-3 pr-3 font-medium">Адрес</th>
                <th className="py-3 pr-3 font-medium">Сеть</th>
                <th className="py-3 pr-3 font-medium">Баланс</th>
                <th className="py-3 pr-3 font-medium">Обновлен</th>
                <th className="py-3 pr-3 font-medium">Ссылка</th>
                <th className="py-3 pr-3 font-medium">Действие</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((wallet) => (
                <tr className="border-b border-zinc-900 last:border-b-0" key={wallet.address}>
                  <td className="py-3 pr-3 font-semibold text-zinc-200">{wallet.address}</td>
                  <td className="py-3 pr-3 text-zinc-400">{displayWalletNetwork(wallet)}</td>
                  <td className="py-3 pr-3 text-zinc-500">
                    {wallet.liveData ? `${wallet.liveData.balance} ${wallet.liveData.symbol}` : "not loaded"}
                  </td>
                  <td className="py-3 pr-3 text-zinc-500">
                    {new Date(wallet.updatedAt || wallet.createdAt).toLocaleString("ru-RU")}
                  </td>
                  <td className="py-3 pr-3">
                    <button className="ghost-button min-h-8" onClick={() => openWallet(wallet)} type="button">
                      Открыть
                    </button>
                  </td>
                  <td className="py-3 pr-3">
                    <button className="ghost-button min-h-8 text-sentinel-danger" onClick={() => deleteWallet(wallet)} type="button">
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
          Сохраненных адресов пока нет. Перейдите в «Обзор» и выполните первый поиск.
        </div>
      )}
    </section>
  );
}

function localDateTimeValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function traceEndpointStatus(status) {
  return {
    known_entity: "Известная организация",
    no_outgoing_in_window: "Дальше не ушли в выбранном окне",
    depth_limit: "Последний адрес на выбранной глубине",
    time_limit: "Закончился период проверки",
    branch_limit: "Остались на адресе из-за лимита веток",
    scan_limit: "Технический лимит проверки",
    cycle: "Возврат на прежний адрес",
    unallocated: "Не сопоставлены с исходящими переводами",
  }[status] || status;
}

function traceExitTypeLabel(type) {
  return {
    exchange: "Биржа",
    bridge: "Мост в другую сеть",
    dex: "DEX / обмен",
    mixer: "Миксер",
    payment_service: "Платёжный сервис",
    gambling: "Игровой сервис",
    sanctioned_entity: "Санкционная организация",
    reported_illicit: "Адрес с сообщением о противоправной деятельности",
    known_entity: "Известная организация",
  }[type] || type || "Неизвестный тип";
}

function traceNetworkForAddress(value, fallback = "ETH") {
  const address = String(value || "").trim();
  if (/^T[A-Za-z0-9]{25,40}$/.test(address)) return "TRX";
  if (isBitcoinAddressValue(address)) return "BTC";
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return ["TRX", "BTC", "UNKNOWN"].includes(fallback) ? "ETH" : fallback;
  }
  return "UNKNOWN";
}

function investigatorExitRequestText(report, exitPoint) {
  const transactionLines = (exitPoint?.transactions || []).map(
    (transaction) =>
      `- ${transaction.timestamp}; ${transaction.transactionAmountFormatted} ${transaction.tokenSymbol}; ${transaction.sourceAddress} -> ${transaction.destinationAddress}; tx ${transaction.transactionHash}`
  );

  return [
    "ЧЕРНОВИК ЗАПРОСА О СОХРАНЕНИИ И ПРЕДОСТАВЛЕНИИ СВЕДЕНИЙ",
    `Организация: ${exitPoint?.entity?.name || "уточнить"}`,
    `Тип: ${traceExitTypeLabel(exitPoint?.exitType)}`,
    `Сеть: ${report?.networkKey || "TRX"}`,
    `Адрес назначения: ${exitPoint?.address || ""}`,
    `Источник метки: ${exitPoint?.entity?.source || "локальная база; требуется подтверждение"}`,
    "",
    "Транзакции:",
    ...transactionLines,
    "",
    "Просьба обеспечить сохранность и, при наличии надлежащего правового основания, предоставить: данные KYC владельца аккаунта/депозитного адреса, связанные аккаунты и адреса, историю поступлений и выводов, IP-адреса и журналы входов, устройства, контактные данные и сведения о дальнейших переводах.",
    "",
    "Примечание: этот текст является техническим черновиком и должен быть приведён в соответствие с применимым процессуальным законодательством уполномоченным сотрудником.",
  ].join("\n");
}

function investigatorTraceText(report) {
  if (!report?.summary) {
    return "";
  }

  const lines = [
    "ОТЧЁТ О ТРАССИРОВКЕ ЦИФРОВЫХ АКТИВОВ",
    `Номер отчёта: ${report.reportId}`,
    `Сформирован: ${new Date(report.generatedAt).toLocaleString("ru-RU")}`,
    `Исходный адрес: ${report.rootAddress}`,
    `Сеть: ${report.networkKey}`,
    `Период: ${new Date(report.query.startAt).toLocaleString("ru-RU")} — ${new Date(report.query.endAt).toLocaleString("ru-RU")}`,
    `Актив: ${report.summary.tokenSymbol || report.query.tokenSymbol}`,
    "",
    "КРАТКИЙ ВЫВОД",
    report.summary.conclusion || report.summary.message || "Вывод отсутствует.",
    `Исходящих переводов найдено: ${report.summary.seedTransfersFound || 0}`,
    `Прослеживаемая сумма: ${report.summary.seedAmountFormatted || 0} ${report.summary.tokenSymbol || report.query.tokenSymbol}`,
    `Адресов назначения в пределах проверки: ${report.summary.endpointCount || 0}`,
    "",
    "МАРШРУТ",
    ...(report.steps || []).map(
      (step) =>
        `Hop ${step.hop} | ${step.timestamp} | ${step.sourceAddress} -> ${step.destinationAddress} | tx ${step.transactionHash} | перевод ${step.transactionAmountFormatted} ${step.tokenSymbol} | отнесено к маршруту ${step.attributedAmountFormatted} ${step.tokenSymbol} | ${step.relation === "direct_fact" ? "факт" : `вероятная связь ${step.confidence}%`}`
    ),
    "",
    "ТОЧКИ СБОРА: ГДЕ ВЕТКИ СНОВА СОШЛИСЬ",
    ...(report.convergences || []).length
      ? (report.convergences || []).flatMap((convergence) => [
          `${convergence.address} | сошлось веток ${convergence.branchCount} | источников ${convergence.sourceCount} | отнесено ${convergence.attributedAmountFormatted} ${convergence.tokenSymbol} | ${Number(convergence.seedCoveragePercent || 0).toFixed(2)}% исходной суммы | уверенность ${convergence.confidence}%${convergence.entity ? ` | ${convergence.entity.name}` : " | владелец не установлен"}`,
          ...convergence.transactions.map(
            (transaction) =>
              `  ${transaction.timestamp} | ${transaction.sourceAddress} -> ${transaction.destinationAddress} | ${transaction.transactionAmountFormatted} ${transaction.tokenSymbol} | ветка от ${transaction.originRecipientAddress} | tx ${transaction.transactionHash}`
          ),
        ])
      : ["В выбранных пределах адрес, на котором сходятся две или более прослеженные ветки, не найден."],
    "",
    "ТОЧКИ ВЫХОДА И ИЗВЕСТНЫЕ ОРГАНИЗАЦИИ",
    ...(report.exitPoints || []).length
      ? (report.exitPoints || []).map(
          (exitPoint) =>
            `${exitPoint.address} | ${traceExitTypeLabel(exitPoint.exitType)} | ${exitPoint.entity?.name || "без названия"} | отнесено ${exitPoint.attributedAmountFormatted} ${exitPoint.tokenSymbol} | уверенность маршрута ${exitPoint.routeConfidence}% | уверенность метки ${exitPoint.labelConfidence}% | источник ${exitPoint.entity?.source || "не указан"}`
        )
      : ["Подтверждённая по подключённой базе точка выхода не найдена."],
    "",
    "ВОЗМОЖНАЯ СМЕНА АКТИВА",
    ...(report.assetTransitions || []).length
      ? (report.assetTransitions || []).map(
          (transition) =>
            `${transition.timestamp} | ${transition.sourceAddress} | ${transition.fromTokenSymbol} -> ${transition.toTokenSymbol} | ${transition.transactionAmountFormatted} ${transition.toTokenSymbol} | совпадение суммы ${Number(transition.similarityPercent || 0).toFixed(1)}% | уверенность ${transition.confidence}% | tx ${transition.transactionHash}`
        )
      : ["Кандидаты смены поддерживаемого стейблкоина не найдены."],
    "",
    "КОНКУРИРУЮЩИЕ ВАРИАНТЫ",
    ...(report.comparisons || []).flatMap((comparison) => [
      `После поступления ${comparison.receivedAmountFormatted} ${comparison.tokenSymbol} на ${comparison.sourceAddress}: найдено ${comparison.totalCandidates} исходящих кандидатов, сильных совпадений ${comparison.activity?.strongMatches || 0}.`,
      ...comparison.candidates.map(
        (candidate) =>
          `${candidate.selected ? "ВЫБРАН МОДЕЛЬЮ" : "АЛЬТЕРНАТИВА"} | ${candidate.timestamp} | ${candidate.destinationAddress} | ${candidate.transactionAmountFormatted} ${candidate.tokenSymbol} | совпадение ${Number(candidate.similarityPercent || 0).toFixed(1)}% | задержка ${candidate.delayMinutes} мин. | оценка ${candidate.confidence}% | tx ${candidate.transactionHash}`
      ),
    ]),
    "",
    "КОНЕЧНЫЕ АДРЕСА В ПРЕДЕЛАХ ПРОВЕРКИ",
    ...((report.terminalAddresses?.length ? report.terminalAddresses : report.endpoints) || []).map(
      (endpoint) =>
        `${endpoint.address} | ${endpoint.amountFormatted} ${endpoint.tokenSymbol} | ${traceEndpointStatus(endpoint.status)} | путей ${endpoint.pathCount || 1}${endpoint.entity ? ` | ${endpoint.entity.name}, ${traceExitTypeLabel(endpoint.exitType || endpoint.entity.category)}, источник ${endpoint.entity.source}` : " | владелец по локальной базе не установлен"}`
    ),
    "",
    "ОГРАНИЧЕНИЯ",
    ...(report.limitations || []).map((item) => `- ${item}`),
    "",
    `SHA-256 отчёта: ${report.evidenceManifest?.reportSha256 || "не сформирован"}`,
    `Источник данных: ${report.provider || "не указан"}`,
  ];

  return lines.join("\n");
}

function traceCsvCell(value) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}

function investigatorTraceCsv(report) {
  const headers = [
    "record_type",
    "hop",
    "status",
    "confidence_percent",
    "timestamp_utc",
    "from_address",
    "to_address",
    "transaction_amount",
    "attributed_amount",
    "token",
    "transaction_hash",
    "entity",
    "amount_similarity_percent",
    "delay_minutes",
  ];
  const rows = [headers];

  for (const step of report.steps || []) {
    rows.push([
      "route_step",
      step.hop,
      step.relation === "direct_fact" ? "blockchain_fact" : "probable_allocation",
      step.confidence,
      step.timestamp,
      step.sourceAddress,
      step.destinationAddress,
      step.transactionAmountFormatted,
      step.attributedAmountFormatted,
      step.tokenSymbol,
      step.transactionHash,
      step.destinationEntity?.name || "",
      step.similarityPercent ?? "",
      step.delayMinutes ?? "",
    ]);
  }

  for (const convergence of report.convergences || []) {
    for (const transaction of convergence.transactions || []) {
      rows.push([
        "convergence_evidence",
        convergence.hop,
        "possible_consolidation",
        transaction.confidence,
        transaction.timestamp,
        transaction.sourceAddress,
        transaction.destinationAddress,
        transaction.transactionAmountFormatted,
        transaction.attributedAmountFormatted,
        transaction.tokenSymbol,
        transaction.transactionHash,
        convergence.entity?.name || "",
        "",
        "",
      ]);
    }
  }

  for (const exitPoint of report.exitPoints || []) {
    for (const transaction of exitPoint.transactions || []) {
      rows.push([
        "exit_point",
        exitPoint.hop,
        exitPoint.exitType,
        transaction.confidence,
        transaction.timestamp,
        transaction.sourceAddress,
        transaction.destinationAddress,
        transaction.transactionAmountFormatted,
        transaction.attributedAmountFormatted,
        transaction.tokenSymbol,
        transaction.transactionHash,
        exitPoint.entity?.name || "",
        "",
        "",
      ]);
    }
  }

  for (const transition of report.assetTransitions || []) {
    rows.push([
      "asset_transition_candidate",
      transition.hop,
      `${transition.fromTokenSymbol}_to_${transition.toTokenSymbol}`,
      transition.confidence,
      transition.timestamp,
      transition.sourceAddress,
      transition.destinationAddress,
      transition.transactionAmountFormatted,
      "",
      transition.toTokenSymbol,
      transition.transactionHash,
      transition.destinationEntity?.name || "",
      transition.similarityPercent,
      transition.delayMinutes,
    ]);
  }

  for (const comparison of report.comparisons || []) {
    for (const candidate of comparison.candidates || []) {
      rows.push([
        "candidate",
        comparison.hop,
        candidate.selected ? "selected_by_model" : "alternative",
        candidate.confidence,
        candidate.timestamp,
        comparison.sourceAddress,
        candidate.destinationAddress,
        candidate.transactionAmountFormatted,
        candidate.attributedAmountFormatted || "",
        candidate.tokenSymbol,
        candidate.transactionHash,
        candidate.destinationEntity?.name || "",
        candidate.similarityPercent,
        candidate.delayMinutes,
      ]);
    }
  }

  for (const terminal of report.terminalAddresses || []) {
    rows.push([
      "terminal_address",
      terminal.maxHop,
      terminal.isExchange ? "exchange_terminal" : terminal.status,
      terminal.confidence,
      "",
      "",
      terminal.address,
      terminal.amountFormatted,
      terminal.amountFormatted,
      terminal.tokenSymbol,
      (terminal.transactionHashes || []).join(" | "),
      terminal.entity?.name || "",
      "",
      "",
    ]);
  }

  return `\uFEFF${rows.map((row) => row.map(traceCsvCell).join(";")).join("\r\n")}`;
}

function downloadTraceFile({ content, filename, type }) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function automatedInvestigationText(automation) {
  if (!automation) return "";

  const exchangeLines = automation.exchangeHits.length
    ? automation.exchangeHits.map((item) => `- ${item.address}: ${item.entity.name}, уверенность метки ${item.entity.confidence}%, источник ${item.entity.source}`)
    : ["- Биржевые адреса по подключённой базе не найдены."];
  const unknownLines = automation.unknownEndpoints.length
    ? automation.unknownEndpoints.map((item) => `- ${item.address}: владелец и организация не установлены.`)
    : ["- Неустановленных конечных адресов нет."];

  return [
    "АВТОМАТИЧЕСКИЙ ИТОГ РАССЛЕДОВАНИЯ",
    `Отчёт трассировки: ${automation.reportId}`,
    `Сформирован: ${new Date(automation.generatedAt).toLocaleString("ru-RU")}`,
    `Исходный адрес: ${automation.rootAddress}`,
    `Проверено переходов: до ${automation.depth}`,
    `Подтверждённых транзакций в маршруте: ${automation.factCount}`,
    `Вероятных связей после первого перехода: ${automation.hypothesisCount}`,
    `Конечных адресов: ${automation.endpointCount}`,
    `Точек схождения веток: ${automation.convergenceCount}`,
    `Известных точек выхода: ${automation.exitPointCount}`,
    `Адресов бирж: ${automation.exchangeHits.length}`,
    `Неустановленных конечных адресов: ${automation.unknownEndpoints.length}`,
    `Автоматически поставлено под наблюдение: ${automation.watchlistAdded}`,
    automation.savedCaseId ? `Сохранено в дело: ${automation.savedCaseId}` : "Автоматическое сохранение дела не выполнено.",
    "",
    "БИРЖИ И КАСТОДИАЛЬНЫЕ СЕРВИСЫ",
    ...exchangeLines,
    "",
    "НЕУСТАНОВЛЕННЫЕ КОНЕЧНЫЕ АДРЕСА",
    ...unknownLines,
    "",
    "ВЫВОД",
    automation.conclusion,
    "",
    "ЮРИДИЧЕСКОЕ ОГРАНИЧЕНИЕ",
    "Блокчейн подтверждает транзакции между адресами. Личность физического владельца устанавливается ответом биржи, данными устройства, ключами либо другими процессуальными доказательствами.",
  ].join("\n");
}

function FundTraceGraph({ report, copyValue }) {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const graph = useMemo(() => {
    const steps = report?.steps || [];
    const endpoints = report?.endpoints || [];
    const exitByAddress = new Map((report?.exitPoints || []).map((item) => [String(item.address || "").toLowerCase(), item]));
    const endpointByNode = new Map();

    for (const endpoint of endpoints) {
      endpointByNode.set(`${Number(endpoint.hop || 0)}:${String(endpoint.address || "").toLowerCase()}`, endpoint);
    }

    const nodeMap = new Map();
    const ensureNode = ({ address, hop, entity = null }) => {
      const id = `${Number(hop || 0)}:${String(address || "").toLowerCase()}`;
      const endpoint = endpointByNode.get(id) || null;
      const exitPoint = exitByAddress.get(String(address || "").toLowerCase()) || null;
      const current = nodeMap.get(id) || {
        id,
        address,
        hop: Number(hop || 0),
        entity: null,
        endpoint: null,
        exitPoint: null,
      };
      current.entity = current.entity || entity || endpoint?.entity || exitPoint?.entity || null;
      current.endpoint = current.endpoint || endpoint;
      current.exitPoint = current.exitPoint || exitPoint;
      nodeMap.set(id, current);
      return current;
    };

    ensureNode({ address: report?.rootAddress || "", hop: 0 });
    const edges = steps.map((step) => {
      const source = ensureNode({ address: step.sourceAddress, hop: Math.max(0, Number(step.hop || 1) - 1) });
      const target = ensureNode({ address: step.destinationAddress, hop: Number(step.hop || 1), entity: step.destinationEntity });
      return {
        id: step.id,
        sourceId: source.id,
        targetId: target.id,
        step,
      };
    });
    const levels = new Map();

    for (const node of nodeMap.values()) {
      if (!levels.has(node.hop)) levels.set(node.hop, []);
      levels.get(node.hop).push(node);
    }

    const maxHop = Math.max(0, ...levels.keys());
    const maxRows = Math.max(1, ...[...levels.values()].map((items) => items.length));
    const width = Math.max(920, 260 + maxHop * 300);
    const height = Math.max(440, 110 + maxRows * 84);
    const positionedNodes = [];

    for (const [hop, items] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
      items.sort((a, b) => {
        const aPriority = Number(Boolean(a.exitPoint)) * 4 + Number(Boolean(a.endpoint)) * 2 + Number(Boolean(a.entity));
        const bPriority = Number(Boolean(b.exitPoint)) * 4 + Number(Boolean(b.endpoint)) * 2 + Number(Boolean(b.entity));
        return bPriority - aPriority || a.address.localeCompare(b.address);
      });
      items.forEach((node, index) => {
        positionedNodes.push({
          ...node,
          x: 130 + hop * 300,
          y: items.length === 1 ? height / 2 : 70 + index * ((height - 140) / Math.max(1, items.length - 1)),
        });
      });
    }

    const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
    const incomingCount = new Map();
    for (const edge of edges) incomingCount.set(edge.targetId, (incomingCount.get(edge.targetId) || 0) + 1);

    return {
      width,
      height,
      maxHop,
      nodes: positionedNodes.map((node) => ({ ...node, incomingCount: incomingCount.get(node.id) || 0 })),
      edges,
      positionedById,
    };
  }, [report]);

  useEffect(() => {
    setSelectedNodeId(`0:${String(report?.rootAddress || "").toLowerCase()}`);
  }, [report?.reportId, report?.rootAddress]);

  if (!report?.steps?.length) return null;

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) || graph.nodes[0];
  const selectedIncoming = graph.edges.filter((edge) => edge.targetId === selectedNode?.id);
  const selectedOutgoing = graph.edges.filter((edge) => edge.sourceId === selectedNode?.id);
  const nodeColor = (node) => {
    if (node.hop === 0) return { fill: "#082714", stroke: "#2fd16b", text: "#73e69b" };
    if (node.exitPoint?.exitType === "exchange") return { fill: "#2b2109", stroke: "#d8a84e", text: "#f1cd78" };
    if (node.endpoint) return { fill: "#2a0c0d", stroke: "#f25555", text: "#ff8d8d" };
    if (node.incomingCount > 1) return { fill: "#17112e", stroke: "#8b78ff", text: "#b8adff" };
    if (node.entity) return { fill: "#082229", stroke: "#36b7cc", text: "#7cd8e8" };
    return { fill: "#111111", stroke: "#52525b", text: "#d4d4d8" };
  };

  return (
    <div className="panel overflow-hidden p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-label">ВИЗУАЛЬНОЕ ДЕРЕВО ДВИЖЕНИЯ СРЕДСТВ</p>
          <h2 className="mt-2 text-xl font-semibold text-zinc-100">Все найденные ветки: 1 → много → схождение → конечные адреса</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
            Нажмите на кошелёк в графе, чтобы увидеть суммы, хеши переводов и статус связи. Один узел с несколькими входящими линиями означает повторный сбор средств.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className="rounded border border-sentinel-green/50 px-2 py-1 text-sentinel-green">Исходный</span>
          <span className="rounded border border-violet-400/50 px-2 py-1 text-violet-300">Схождение веток</span>
          <span className="rounded border border-sentinel-warning/50 px-2 py-1 text-sentinel-warning">Биржа</span>
          <span className="rounded border border-sentinel-danger/50 px-2 py-1 text-sentinel-danger">Конечный</span>
        </div>
      </div>

      <div className="mt-4 max-h-[760px] overflow-auto rounded-lg border border-zinc-800 bg-black">
        <svg height={graph.height} style={{ minWidth: graph.width }} viewBox={`0 0 ${graph.width} ${graph.height}`} width={graph.width}>
          <defs>
            <marker id="fund-trace-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
              <path d="M0,0 L8,4 L0,8 Z" fill="#71717a" />
            </marker>
            <marker id="fund-trace-arrow-fact" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
              <path d="M0,0 L8,4 L0,8 Z" fill="#2fd16b" />
            </marker>
          </defs>
          {Array.from({ length: graph.maxHop + 1 }, (_, hop) => (
            <g key={`hop-label-${hop}`}>
              <line stroke="#202024" strokeDasharray="4 8" x1={130 + hop * 300} x2={130 + hop * 300} y1="42" y2={graph.height - 24} />
              <text fill="#71717a" fontSize="11" fontWeight="700" textAnchor="middle" x={130 + hop * 300} y="24">{hop === 0 ? "ИСХОДНЫЙ" : `HOP ${hop}`}</text>
            </g>
          ))}
          {graph.edges.map((edge) => {
            const source = graph.positionedById.get(edge.sourceId);
            const target = graph.positionedById.get(edge.targetId);
            if (!source || !target) return null;
            const direct = edge.step.relation === "direct_fact";
            const path = `M ${source.x + 105} ${source.y} C ${source.x + 155} ${source.y}, ${target.x - 155} ${target.y}, ${target.x - 105} ${target.y}`;
            return (
              <path
                className="cursor-pointer"
                d={path}
                fill="none"
                key={edge.id}
                markerEnd={direct ? "url(#fund-trace-arrow-fact)" : "url(#fund-trace-arrow)"}
                onClick={() => setSelectedNodeId(edge.targetId)}
                stroke={direct ? "#2fd16b" : "#71717a"}
                strokeDasharray={direct ? undefined : "7 5"}
                strokeOpacity="0.82"
                strokeWidth={direct ? "2.6" : "2"}
              >
                <title>{`${edge.step.sourceAddress} → ${edge.step.destinationAddress}\n${edge.step.transactionAmountFormatted} ${edge.step.tokenSymbol}\n${edge.step.transactionHash}`}</title>
              </path>
            );
          })}
          {graph.nodes.map((node) => {
            const color = nodeColor(node);
            const selected = node.id === selectedNode?.id;
            const label = node.entity?.name || shortAddress(node.address);
            const caption = node.exitPoint?.exitType === "exchange"
              ? "БИРЖА"
              : node.endpoint
                ? traceEndpointStatus(node.endpoint.status)
                : node.incomingCount > 1
                  ? `СОШЛОСЬ ВЕТОК: ${node.incomingCount}`
                  : `Hop ${node.hop}`;
            return (
              <g className="cursor-pointer" key={node.id} onClick={() => setSelectedNodeId(node.id)} role="button">
                <rect fill={color.fill} height="58" rx="8" stroke={color.stroke} strokeWidth={selected ? "3" : "1.5"} width="210" x={node.x - 105} y={node.y - 29} />
                <text fill={color.text} fontSize="12" fontWeight="700" textAnchor="middle" x={node.x} y={node.y - 5}>{String(label).slice(0, 28)}</text>
                <text fill="#71717a" fontSize="9" textAnchor="middle" x={node.x} y={node.y + 14}>{String(caption).slice(0, 36)}</text>
                <title>{`${node.address}${node.entity ? `\n${node.entity.name}` : ""}`}</title>
              </g>
            );
          })}
        </svg>
      </div>

      {selectedNode ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-zinc-500">Выбранный узел · Hop {selectedNode.hop}</p>
              <p className="mt-2 break-all font-mono text-sm text-zinc-100">{selectedNode.address}</p>
              {selectedNode.entity ? <p className="mt-2 font-semibold text-sentinel-warning">{selectedNode.entity.name} · {traceExitTypeLabel(selectedNode.exitPoint?.exitType || selectedNode.entity.category)}</p> : null}
              {selectedNode.endpoint ? <p className="mt-2 text-xs text-sentinel-danger">{traceEndpointStatus(selectedNode.endpoint.status)}</p> : null}
            </div>
            <button className="ghost-button min-h-9 px-3 text-xs" onClick={() => copyValue?.(selectedNode.address, "Адрес скопирован")} type="button">Копировать адрес</button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-zinc-400">Входящие переводы в этом маршруте: {selectedIncoming.length}</p>
              <div className="mt-2 grid gap-2">
                {selectedIncoming.length ? selectedIncoming.map((edge) => (
                  <button className="rounded border border-zinc-900 p-3 text-left text-xs text-zinc-500 hover:border-zinc-700" key={edge.id} onClick={() => copyValue?.(edge.step.transactionHash, "Хеш скопирован")} type="button">
                    <span className="text-zinc-200">{edge.step.transactionAmountFormatted} {edge.step.tokenSymbol}</span> · {edge.step.relation === "direct_fact" ? "факт" : `вероятная связь ${edge.step.confidence}%`}
                    <span className="mt-1 block break-all font-mono text-zinc-600">tx {edge.step.transactionHash}</span>
                  </button>
                )) : <p className="text-xs text-zinc-600">Это исходный адрес.</p>}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-400">Дальнейшие переводы в этом маршруте: {selectedOutgoing.length}</p>
              <div className="mt-2 grid gap-2">
                {selectedOutgoing.length ? selectedOutgoing.map((edge) => (
                  <button className="rounded border border-zinc-900 p-3 text-left text-xs text-zinc-500 hover:border-zinc-700" key={edge.id} onClick={() => setSelectedNodeId(edge.targetId)} type="button">
                    <span className="text-zinc-200">→ {shortAddress(edge.step.destinationAddress)}</span> · {edge.step.attributedAmountFormatted} {edge.step.tokenSymbol}
                    <span className="mt-1 block break-all font-mono text-zinc-600">tx {edge.step.transactionHash}</span>
                  </button>
                )) : <p className="text-xs text-sentinel-danger">Это конечный адрес в пределах проверки.</p>}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function splitAddressList(value) {
  return [...new Set(String(value || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function AddressConnectionsGraph({ result, onSelect, selectedAddress }) {
  const graph = useMemo(() => {
    if (!result?.graph?.nodes?.length) return null;
    const important = new Set((result.request?.addresses || []).map((item) => String(item).toLowerCase()));
    for (const item of result.convergencePoints || []) important.add(String(item.address).toLowerCase());
    for (const item of result.commonRecipients || []) important.add(String(item.address).toLowerCase());
    for (const item of result.commonSenders || []) important.add(String(item.address).toLowerCase());
    for (const item of result.pathsBetweenInputs || []) {
      for (const address of item.path || []) important.add(String(address).toLowerCase());
    }
    for (const edge of result.directTransfers || []) {
      important.add(String(edge.from).toLowerCase());
      important.add(String(edge.to).toLowerCase());
    }
    for (const item of (result.observedEndpoints || []).slice(0, 12)) important.add(String(item.address).toLowerCase());

    const allNodes = result.graph.nodes || [];
    const nodeByLower = new Map(allNodes.map((node) => [String(node.key || node.address).toLowerCase(), node]));
    let nodes = [...important].map((key) => nodeByLower.get(key)).filter(Boolean);
    if (nodes.length < 8) {
      const extras = allNodes.filter((node) => !important.has(String(node.key || node.address).toLowerCase())).slice(0, 8 - nodes.length);
      nodes = [...nodes, ...extras];
    }
    nodes = nodes.slice(0, 50);
    const included = new Set(nodes.map((node) => node.key));
    const edges = (result.graph.edges || []).filter((edge) => included.has(edge.from) && included.has(edge.to)).slice(0, 100);
    const commonSenders = new Set((result.commonSenders || []).map((item) => item.address));
    const levels = new Map();
    for (const node of nodes) {
      const level = node.isInput ? 1 : commonSenders.has(node.key) && node.firstHop == null ? 0 : Math.max(2, Number(node.firstHop || 1) + 1);
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(node);
    }
    const maxLevel = Math.max(1, ...levels.keys());
    const maxRows = Math.max(1, ...[...levels.values()].map((items) => items.length));
    const width = Math.max(920, 280 + maxLevel * 290);
    const height = Math.max(430, 100 + maxRows * 76);
    const positioned = [];
    for (const [level, items] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
      items.sort((a, b) => Number(b.originCount || 0) - Number(a.originCount || 0) || a.address.localeCompare(b.address));
      items.forEach((node, index) => positioned.push({
        ...node,
        level,
        x: 135 + level * 290,
        y: items.length === 1 ? height / 2 : 65 + index * ((height - 130) / Math.max(1, items.length - 1)),
      }));
    }
    return { nodes: positioned, edges, byId: new Map(positioned.map((node) => [node.key, node])), width, height, maxLevel };
  }, [result]);

  if (!graph) return null;
  const nodeColors = (node) => {
    if (node.isInput) return { fill: "#082714", stroke: "#2fd16b", text: "#73e69b" };
    if (node.role === "convergence") return { fill: "#17112e", stroke: "#8b78ff", text: "#b8adff" };
    if (node.role === "observed_endpoint") return { fill: "#2b2109", stroke: "#d8a84e", text: "#f1cd78" };
    return { fill: "#111111", stroke: "#52525b", text: "#d4d4d8" };
  };

  return (
    <div className="mt-4 max-h-[720px] overflow-auto rounded-lg border border-zinc-800 bg-black">
      <svg height={graph.height} style={{ minWidth: graph.width }} viewBox={`0 0 ${graph.width} ${graph.height}`} width={graph.width}>
        <defs>
          <marker id="connections-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0,0 L8,4 L0,8 Z" fill="#71717a" />
          </marker>
        </defs>
        {Array.from({ length: graph.maxLevel + 1 }, (_, level) => (
          <g key={`connections-level-${level}`}>
            <line stroke="#202024" strokeDasharray="4 8" x1={135 + level * 290} x2={135 + level * 290} y1="38" y2={graph.height - 20} />
            <text fill="#71717a" fontSize="10" fontWeight="700" textAnchor="middle" x={135 + level * 290} y="21">
              {level === 0 ? "ОТКУДА ПРИХОДИЛО" : level === 1 ? "ВВЕДЁННЫЕ АДРЕСА" : `УРОВЕНЬ ${level - 1}`}
            </text>
          </g>
        ))}
        {graph.edges.map((edge) => {
          const source = graph.byId.get(edge.from);
          const target = graph.byId.get(edge.to);
          if (!source || !target) return null;
          return (
            <path
              d={`M ${source.x + 102} ${source.y} C ${source.x + 145} ${source.y}, ${target.x - 145} ${target.y}, ${target.x - 102} ${target.y}`}
              fill="none"
              key={edge.id}
              markerEnd="url(#connections-arrow)"
              stroke="#71717a"
              strokeOpacity="0.78"
              strokeWidth={Math.min(4, 1.5 + Number(edge.transactionCount || 1) * 0.25)}
            >
              <title>{`${edge.from} → ${edge.to}\n${edge.totalValue || "0"} ${edge.symbol} · ${edge.transactionCount} транз.`}</title>
            </path>
          );
        })}
        {graph.nodes.map((node) => {
          const color = nodeColors(node);
          const selected = String(selectedAddress || "").toLowerCase() === String(node.key).toLowerCase();
          return (
            <g className="cursor-pointer" key={node.key} onClick={() => onSelect(node)} role="button">
              <rect fill={color.fill} height="58" rx="8" stroke={color.stroke} strokeWidth={selected ? "3" : "1.5"} width="204" x={node.x - 102} y={node.y - 29} />
              <text fill={color.text} fontSize="11" fontWeight="700" textAnchor="middle" x={node.x} y={node.y - 5}>{shortAddress(node.address)}</text>
              <text fill="#71717a" fontSize="9" textAnchor="middle" x={node.x} y={node.y + 14}>
                {node.isInput ? "ВВЕДЁННЫЙ" : node.role === "convergence" ? `СОШЛОСЬ: ${node.originCount}` : node.role === "observed_endpoint" ? "КОНЕЦ В ЗАГРУЖЕННЫХ ДАННЫХ" : "СВЯЗАННЫЙ"}
              </text>
              <title>{node.address}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AddressConnectionsPanel({ initialAddress = "", profile, activeWorkspaceId }) {
  const storagePrefix = `chainsentinel:connections:${activeWorkspaceId || "default"}`;
  const [addressText, setAddressText] = useSessionState(`${storagePrefix}:addresses`, initialAddress || "");
  const [networkKey, setNetworkKey] = useSessionState(`${storagePrefix}:network`, () => traceNetworkForAddress(initialAddress, profile?.networkKey || "ETH") === "UNKNOWN" ? "TRX" : traceNetworkForAddress(initialAddress, profile?.networkKey || "ETH"));
  const [depth, setDepth] = useSessionState(`${storagePrefix}:depth`, 2);
  const [limitPerAddress, setLimitPerAddress] = useSessionState(`${storagePrefix}:limit`, 50);
  const [result, setResult] = useSessionState(`${storagePrefix}:result`, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedNodeKey, setSelectedNodeKey] = useSessionState(`${storagePrefix}:selected-node`, "");
  const addresses = useMemo(() => splitAddressList(addressText), [addressText]);
  const networkOptions = useMemo(() => [
    { key: "TRX", name: "TRON" },
    { key: "BTC", name: "Bitcoin" },
    ...EVM_NETWORKS,
  ], []);
  const selectedNode = useMemo(
    () => result?.graph?.nodes?.find((node) => node.key === selectedNodeKey) || result?.graph?.nodes?.find((node) => node.isInput) || null,
    [result, selectedNodeKey]
  );

  useEffect(() => {
    if (initialAddress && !addressText.trim()) setAddressText(initialAddress);
  }, [initialAddress, addressText]);

  const run = async (event) => {
    event.preventDefault();
    setError("");
    setResult(null);
    setSelectedNodeKey("");
    if (addresses.length < 2) {
      setError("Вставьте минимум два разных адреса — каждый с новой строки или через запятую.");
      return;
    }
    if (addresses.length > 25) {
      setError("За один запуск можно проверить не более 25 адресов.");
      return;
    }
    setLoading(true);
    try {
      const data = await analyzeV2AddressConnections({ addresses, networkKey, depth, limitPerAddress });
      setResult(data);
      setSelectedNodeKey(data.graph?.nodes?.find((node) => node.isInput)?.key || "");
    } catch (runError) {
      setError(runError.message || "Не удалось проверить связи адресов.");
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!result) return;
    downloadTraceFile({
      content: JSON.stringify(result, null, 2),
      filename: `chainsentinel-address-connections-${Date.now()}.json`,
      type: "application/json;charset=utf-8",
    });
  };

  const selectedIncoming = result?.graph?.edges?.filter((edge) => edge.to === selectedNode?.key) || [];
  const selectedOutgoing = result?.graph?.edges?.filter((edge) => edge.from === selectedNode?.key) || [];

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="section-label">МАССОВЫЙ ПОИСК СВЯЗЕЙ</p>
          <h1 className="mt-2 text-xl font-semibold text-zinc-100">Какие кошельки связаны между собой</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            Вставьте адреса из одного дела. Платформа проверит реальные транзакции, прямые переводы между ними, общих получателей, взаимные переводы и места, где ветки снова сходятся.
          </p>
        </div>
        <span className="rounded border border-sentinel-green/40 bg-sentinel-green/5 px-3 py-2 text-xs text-sentinel-green">Только данные публичного блокчейна</span>
      </div>

      <form className="mt-5 grid gap-4" onSubmit={run}>
        <label className="grid gap-2 text-xs text-zinc-500">
          Адреса — каждый с новой строки, через пробел или запятую ({addresses.length}/25)
          <textarea
            className="min-h-36 rounded-md border border-zinc-800 bg-black p-3 font-mono text-sm leading-6 text-zinc-100 outline-none focus:border-zinc-600"
            onChange={(event) => setAddressText(event.target.value)}
            placeholder={"T...\nT...\nT..."}
            value={addressText}
          />
        </label>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-2 text-xs text-zinc-500">
            Сеть всех адресов
            <select className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100" onChange={(event) => setNetworkKey(event.target.value)} value={networkKey}>
              {networkOptions.map((network) => <option key={network.key} value={network.key}>{network.name}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-xs text-zinc-500">
            Глубина цепочек
            <select className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100" onChange={(event) => setDepth(Number(event.target.value))} value={depth}>
              <option value="1">1 переход — быстрее</option>
              <option value="2">2 перехода — рекомендуется</option>
              <option value="3">3 перехода — больше запросов</option>
            </select>
          </label>
          <label className="grid gap-2 text-xs text-zinc-500">
            Транзакций на адрес
            <select className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100" onChange={(event) => setLimitPerAddress(Number(event.target.value))} value={limitPerAddress}>
              <option value="25">25 — быстрее</option>
              <option value="50">50 — рекомендуется</option>
              <option value="100">100 — подробнее</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className={`primary-button min-h-11 px-5 ${loading ? "button-loading" : ""}`} disabled={loading} type="submit">
            {loading ? <LoadingDots label="Проверяю адреса и цепочки" /> : "Найти связи и построить граф"}
          </button>
          <p className="text-xs leading-5 text-zinc-500">Все адреса в одном запуске должны относиться к выбранной сети.</p>
        </div>
      </form>

      {error ? <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">{error}</div> : null}

      {result ? (
        <div className="mt-6 border-t border-zinc-800 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="section-label">РЕЗУЛЬТАТ · {result.network?.name}</p>
              <h2 className="mt-2 text-lg font-semibold text-zinc-100">
                {result.summary.connectedGroupCount || result.summary.directTransferCount || result.summary.convergenceCount
                  ? "Связи между адресами обнаружены"
                  : "В загруженной истории связь не обнаружена"}
              </h2>
            </div>
            <button className="ghost-button min-h-9 px-3 text-xs" onClick={download} type="button">Скачать доказательные данные JSON</button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ["Введено", result.summary.inputAddressCount],
              ["Прямые переводы", result.summary.directTransferCount],
              ["Общие получатели", result.summary.commonRecipientCount],
              ["Взаимные связи", result.summary.mutualPairCount],
              ["Точки схождения", result.summary.convergenceCount],
              ["Связанные группы", result.summary.connectedGroupCount],
            ].map(([label, value]) => (
              <div className="rounded-lg border border-zinc-800 bg-black p-3" key={label}>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
                <p className="mt-2 text-xl font-semibold text-zinc-100">{value}</p>
              </div>
            ))}
          </div>

          {(result.facts || []).length ? (
            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              {(result.facts || []).slice(0, 30).map((fact, index) => {
                const lines = fact.type === "common_recipient" || fact.type === "convergence"
                  ? (fact.addresses || []).slice(0, -1).map((item) => `${item} → ${fact.targetAddress}`)
                  : fact.type === "common_sender"
                    ? (fact.addresses || []).slice(1).map((item) => `${fact.sourceAddress} → ${item}`)
                    : fact.type === "mutual_transfer"
                      ? [`${fact.addresses?.[0]} ↔ ${fact.addresses?.[1]}`]
                      : [`${fact.addresses?.[0]} → ${fact.addresses?.[1]}`];
                const structural = fact.status === "structural_connection";
                return (
                  <article className={`rounded-lg border p-4 ${structural ? "border-violet-400/30 bg-violet-400/5" : "border-sentinel-green/30 bg-sentinel-green/5"}`} key={`${fact.type}-${fact.targetAddress || fact.sourceAddress || index}`}>
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-2 py-1 text-[10px] font-semibold ${structural ? "border-violet-400/40 text-violet-300" : "border-sentinel-green/40 text-sentinel-green"}`}>
                        {structural ? "СТРУКТУРНАЯ СВЯЗЬ" : "ПОДТВЕРЖДЕНО В БЛОКЧЕЙНЕ"}
                      </span>
                      {fact.hops ? <span className="text-xs text-zinc-500">до {fact.hops} переходов</span> : null}
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-zinc-100">{fact.title}</h3>
                    <div className="mt-2 grid gap-1">
                      {lines.slice(0, 8).map((line, itemIndex) => <p className="break-all font-mono text-xs text-zinc-500" key={`${line}-${itemIndex}`}>{line}</p>)}
                    </div>
                    {fact.transfers?.length ? (
                      <div className="mt-3 grid gap-2">
                        {fact.transfers.slice(0, 10).map((transfer) => (
                          <div className="rounded border border-zinc-800 bg-black p-3" key={transfer.id}>
                            <p className="text-sm font-semibold text-zinc-100">
                              {transfer.totalValue || "0"} {transfer.symbol}
                              <span className="ml-2 text-xs font-normal text-zinc-500">за {transfer.transactionCount} транз.</span>
                            </p>
                            <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">{transfer.from} → {transfer.to}</p>
                            <p className="mt-1 text-[11px] text-zinc-600">
                              {transfer.firstSeen ? new Date(transfer.firstSeen).toLocaleString("ru-RU") : "дата неизвестна"}
                              {transfer.lastSeen && transfer.lastSeen !== transfer.firstSeen ? ` — ${new Date(transfer.lastSeen).toLocaleString("ru-RU")}` : ""}
                            </p>
                            {transfer.examples?.[0]?.explorerUrl ? (
                              <a className="mt-2 block break-all font-mono text-[11px] text-sentinel-green hover:text-zinc-100" href={transfer.examples[0].explorerUrl} rel="noreferrer" target="_blank">
                                tx {transfer.examples[0].txHash}
                              </a>
                            ) : transfer.txHashes?.[0] ? <p className="mt-2 break-all font-mono text-[11px] text-zinc-600">tx {transfer.txHashes[0]}</p> : null}
                          </div>
                        ))}
                        <p className="text-[11px] leading-5 text-zinc-600">Сумма рассчитана по транзакциям, загруженным из публичного источника; при неполной истории итог может быть ниже фактического.</p>
                      </div>
                    ) : null}
                    {structural ? <p className="mt-2 text-xs leading-5 text-zinc-600">Переводы по каждому ребру существуют, но принадлежность средств и один владелец автоматически не установлены.</p> : null}
                    {fact.txHashes?.length ? <p className="mt-2 break-all font-mono text-[11px] text-zinc-600">tx: {fact.txHashes.slice(0, 3).join(", ")}</p> : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 rounded-lg border border-zinc-800 bg-black p-4 text-sm leading-6 text-zinc-400">
              В загруженных страницах транзакций не найдено прямого перевода, общего контрагента или схождения цепочек. Это не доказывает отсутствие связи: проверьте более точную сеть, увеличьте лимит и учитывайте предупреждения источника.
            </div>
          )}

          <div className="mt-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="section-label">ГРАФ ЦЕПОЧЕК</p>
                <h3 className="mt-1 font-semibold text-zinc-100">Введённые адреса, посредники и точки объединения</h3>
              </div>
              <div className="flex flex-wrap gap-2 text-[10px]">
                <span className="rounded border border-sentinel-green/50 px-2 py-1 text-sentinel-green">Введённый адрес</span>
                <span className="rounded border border-violet-400/50 px-2 py-1 text-violet-300">Схождение</span>
                <span className="rounded border border-sentinel-warning/50 px-2 py-1 text-sentinel-warning">Конец загруженной цепочки</span>
              </div>
            </div>
            <AddressConnectionsGraph onSelect={(node) => setSelectedNodeKey(node.key)} result={result} selectedAddress={selectedNode?.key} />
          </div>

          {selectedNode ? (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wider text-zinc-500">Выбранный адрес · {selectedNode.role}</p>
                  <p className="mt-2 break-all font-mono text-sm text-zinc-100">{selectedNode.address}</p>
                  <p className="mt-2 text-xs text-zinc-500">Входящих связей: {selectedIncoming.length} · исходящих: {selectedOutgoing.length} · веток исходных адресов: {selectedNode.originCount || 0}</p>
                </div>
                <a className="ghost-button inline-flex min-h-9 items-center px-3 text-xs" href={`/transactions/${encodeURIComponent(selectedNode.address)}`}>Открыть все транзакции</a>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {[...selectedIncoming, ...selectedOutgoing].slice(0, 10).map((edge) => (
                  <div className="rounded border border-zinc-900 p-3 text-xs text-zinc-500" key={edge.id}>
                    <p className="break-all font-mono text-zinc-300">{edge.from} → {edge.to}</p>
                    <p className="mt-1">{edge.totalValue || "0"} {edge.symbol} · {edge.transactionCount} транз. · хешей: {edge.txHashes.length}</p>
                    <p className="mt-1 text-zinc-600">{edge.firstSeen ? new Date(edge.firstSeen).toLocaleString("ru-RU") : "дата неизвестна"} — {edge.lastSeen ? new Date(edge.lastSeen).toLocaleString("ru-RU") : "дата неизвестна"}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-5 rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/10 p-4 text-xs leading-6 text-sentinel-warning">
            <strong>Что пока не доказано:</strong> общий адрес назначения, взаимные переводы или схождение веток не устанавливают одного владельца. Для вывода о владельце нужны метки сервиса, сведения биржи/KYC и другие процессуально полученные доказательства.
          </div>
          {result.dataQuality?.errors?.length ? (
            <div className="mt-3 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-4 text-xs leading-6 text-sentinel-danger">
              <strong>История получена не полностью.</strong> {result.dataQuality.errors.slice(0, 8).join(" | ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FundTracePage({ address, profile, activeWorkspaceId, saveWatchlistRule, watchlistRules = [], addFeed, restoredCase }) {
  const storagePrefix = `chainsentinel:trace:${activeWorkspaceId || "default"}`;
  const [rootAddress, setRootAddress] = useSessionState(`${storagePrefix}:root`, address || "");
  const [tokenSymbol, setTokenSymbol] = useSessionState(`${storagePrefix}:token`, "USDT");
  const [startAt, setStartAt] = useSessionState(`${storagePrefix}:start`, () => localDateTimeValue(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)));
  const [endAt, setEndAt] = useSessionState(`${storagePrefix}:end`, () => localDateTimeValue(new Date()));
  const [seedTxHash, setSeedTxHash] = useSessionState(`${storagePrefix}:seed-tx`, "");
  const [amount, setAmount] = useSessionState(`${storagePrefix}:amount`, "");
  const [depth, setDepth] = useSessionState(`${storagePrefix}:depth`, 3);
  const [hopWindowHours, setHopWindowHours] = useSessionState(`${storagePrefix}:hop-window`, 72);
  const [report, setReport] = useSessionState(`${storagePrefix}:report`, null);
  const [publicChainReport, setPublicChainReport] = useSessionState(`${storagePrefix}:public-report`, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [caseStatus, setCaseStatus] = useSessionState(`${storagePrefix}:case-status`, "");
  const [watchingAddress, setWatchingAddress] = useState("");
  const [automation, setAutomation] = useSessionState(`${storagePrefix}:automation`, null);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationPhase, setAutomationPhase] = useSessionState(`${storagePrefix}:automation-phase`, "");

  useEffect(() => {
    if (address) {
      setRootAddress(address);
    }
  }, [address]);

  useEffect(() => {
    if (restoredCase?.traceReport && restoredCase.rootAddress === address) {
      setReport(restoredCase.traceReport);
      setCaseStatus(`Открыто сохранённое дело: ${restoredCase.title}`);
    }
  }, [address, restoredCase]);

  const copyValue = async (value, label = "Скопировано") => {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("Не удалось скопировать");
    }
  };

  const validatedTraceInput = () => {
    const cleanAddress = rootAddress.trim();
    const networkKey = traceNetworkForAddress(cleanAddress, profile?.networkKey || "ETH");

    if (networkKey === "UNKNOWN") {
      throw new Error("Введите корректный адрес TRON, Ethereum/EVM или Bitcoin.");
    }

    if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
      throw new Error("Дата окончания должна быть позже даты начала.");
    }

    return { cleanAddress, networkKey };
  };

  const requestTrace = (options = {}) => {
    const { cleanAddress } = validatedTraceInput();

    return traceWalletFunds({
      address: cleanAddress,
      networkKey: "TRX",
      tokenSymbol,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      seedTxHash,
      amount,
      depth: options.depth ?? depth,
      hopWindowHours: options.hopWindowHours ?? hopWindowHours,
      maxBranches: options.maxBranches ?? 8,
      maxSeeds: options.maxSeeds ?? 20,
    });
  };

  const runTrace = async (event) => {
    event.preventDefault();

    if (traceNetworkKey !== "TRX") {
      await runPublicChainInvestigation(false);
      return;
    }

    setLoading(true);
    setError("");
    setReport(null);
    setPublicChainReport(null);
    setAutomation(null);

    try {
      const result = await requestTrace();
      setReport(result);
    } catch (traceError) {
      setError(traceError.message || "Не удалось выполнить трассировку.");
    } finally {
      setLoading(false);
    }
  };

  const downloadReport = () => {
    if (!report) {
      return;
    }

    downloadTraceFile({
      content: JSON.stringify(report, null, 2),
      filename: `chainsentinel-fund-trace-${report.reportId}.json`,
      type: "application/json;charset=utf-8",
    });
  };

  const downloadTextReport = () => {
    if (!report) {
      return;
    }

    downloadTraceFile({
      content: investigatorTraceText(report),
      filename: `chainsentinel-fund-trace-${report.reportId}.txt`,
      type: "text/plain;charset=utf-8",
    });
  };

  const downloadCsvReport = () => {
    if (!report) {
      return;
    }

    downloadTraceFile({
      content: investigatorTraceCsv(report),
      filename: `chainsentinel-fund-trace-${report.reportId}.csv`,
      type: "text/csv;charset=utf-8",
    });
  };

  const downloadEvidencePackage = () => {
    if (!report) return;
    const evidencePackage = {
      packageType: "ChainSentra investigation evidence package",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      reportSha256: report.evidenceManifest?.reportSha256 || null,
      integrityNotice: report.evidenceManifest?.evidenceNotice || "",
      report,
      automatedInvestigation: automation,
      organizationRequestDrafts: (report.exitPoints || [])
        .filter((exitPoint) => exitPoint.requestRecommended)
        .map((exitPoint) => ({
          address: exitPoint.address,
          entity: exitPoint.entity,
          text: investigatorExitRequestText(report, exitPoint),
        })),
    };

    downloadTraceFile({
      content: JSON.stringify(evidencePackage, null, 2),
      filename: `chainsentinel-evidence-${report.reportId}.json`,
      type: "application/json;charset=utf-8",
    });
  };

  const persistTraceAsCase = async (traceReport, automationData = null) => {
    const severity = (traceReport.exitPoints || []).some((item) => ["mixer", "sanctioned_entity", "reported_illicit"].includes(item.exitType))
      ? "High"
      : "Medium";
    return upsertInvestigationCase({
        profileId: activeWorkspaceId,
        title: `${automationData ? "Полное расследование" : "Трассировка"} ${shortAddress(traceReport.rootAddress)} · ${new Date(traceReport.generatedAt).toLocaleDateString("ru-RU")}`,
        rootAddress: traceReport.rootAddress,
        networkKey: traceReport.networkKey,
        severity,
        status: "open",
        summary: {
          ...traceReport.summary,
          reportId: traceReport.reportId,
          evidenceRecords: traceReport.evidenceManifest?.recordCounts || {},
          reportSha256: traceReport.evidenceManifest?.reportSha256 || "",
          automation: automationData,
        },
        notes: automationData?.conclusion || traceReport.summary.conclusion,
        evidence: [{
          type: "fund_trace",
          reportId: traceReport.reportId,
          generatedAt: traceReport.generatedAt,
          reportSha256: traceReport.evidenceManifest?.reportSha256 || "",
          provider: traceReport.provider,
        }],
        traceReport,
      }, activeWorkspaceId);
  };

  const saveTraceAsCase = async () => {
    if (!report) return;
    setCaseStatus("Сохраняю дело...");

    try {
      const savedCase = await persistTraceAsCase(report, automation);
      setCaseStatus(`Дело сохранено: ${savedCase.id}`);
      addFeed?.(`${report.rootAddress}: отчёт ${report.reportId} сохранён в расследования`);
    } catch (saveError) {
      setCaseStatus(`Не удалось сохранить дело: ${saveError.message}`);
    }
  };

  const addTraceAddressToWatchlist = async (targetAddress) => {
    if (!targetAddress || !saveWatchlistRule) return;
    setWatchingAddress(targetAddress);

    try {
      await saveWatchlistRule({
        address: targetAddress,
        networkName: "TRON",
        eventType: "Любое движение",
        amountLimit: "any",
        assetScope: "stablecoins",
        hideSpamTokens: true,
        channel: "dashboard",
        active: true,
      });
      setCopied("Адрес добавлен под наблюдение");
      addFeed?.(`${targetAddress}: добавлен в watchlist из трассировки`);
    } catch (watchError) {
      setCopied(`Не удалось добавить в наблюдение: ${watchError.message}`);
    } finally {
      setWatchingAddress("");
    }
  };

  const runPublicChainInvestigation = async (full = false) => {
    const { cleanAddress, networkKey } = validatedTraceInput();
    setLoading(true);
    setAutomationRunning(full);
    setError("");
    setReport(null);
    setPublicChainReport(null);
    setAutomation(null);
    setAutomationPhase(full ? "1/4 · Загружаю публичную историю сети без API-ключа" : "Загружаю публичную историю сети без API-ключа");

    try {
      const result = await getMixerChainScan({
        address: cleanAddress,
        networkKey,
        depth: full ? 4 : Math.min(4, Math.max(1, depth)),
        maxPerHop: full ? 8 : 4,
        limit: full ? 100 : 80,
        saveEntities: false,
        persist: true,
        refresh: true,
      });
      const candidateAddresses = [...new Set([
        ...(result.analysis?.exitCandidates || []).map((item) => item.address),
        ...(result.analysis?.chain || []).map((item) => item.address),
      ].filter(Boolean))];

      setAutomationPhase(full ? "2/4 · Проверяю организации и биржи по локальной базе" : "Проверяю организации по локальной базе");
      const attribution = candidateAddresses.length
        ? await attributeAddresses({ addresses: candidateAddresses, networkKey })
        : { results: [], summary: { total: 0, exchanges: 0, otherKnown: 0, unknown: 0, invalid: 0 } };
      const unknownAddresses = attribution.results.filter((item) => item.status === "not_identified");
      let watchlistAdded = 0;

      if (full && saveWatchlistRule) {
        setAutomationPhase("3/4 · Добавляю неизвестные адреса под наблюдение");
        const existing = new Set(watchlistRules.map((rule) => String(rule.address || "").toLowerCase()));
        const watchResults = await Promise.allSettled(unknownAddresses
          .filter((item) => !existing.has(String(item.address || "").toLowerCase()))
          .slice(0, 25)
          .map((item) => saveWatchlistRule({
            address: item.address,
            networkName: networkKey === "BTC" ? "Bitcoin" : networkKey,
            eventType: "Любое движение",
            amountLimit: "any",
            assetScope: "all",
            hideSpamTokens: true,
            channel: "dashboard",
            active: true,
          })));
        watchlistAdded = watchResults.filter((item) => item.status === "fulfilled").length;
      }

      const summary = {
        networkKey,
        checkedAddresses: result.analysis?.chainScan?.checkedAddresses || 1,
        rootTransactions: result.root?.itemCount || 0,
        chainHops: result.analysis?.chain?.length || 0,
        exitCandidates: result.analysis?.exitCandidates?.length || 0,
        exchangeHits: attribution.results.filter((item) => item.isExchange),
        otherKnown: attribution.results.filter((item) => item.identified && !item.isExchange),
        unknownAddresses,
        watchlistAdded,
        provider: result.root?.provider || "Public blockchain API",
        reportId: result.report?.id || result.analysis?.chainScan?.reportId || "",
      };
      setPublicChainReport({ ...result, attribution, summary });
      setAutomationPhase(full ? "4/4 · Многосетевое расследование завершено" : "Анализ завершён");
      addFeed?.(`${cleanAddress}: ${networkKey} анализ без API-ключа, проверено адресов ${summary.checkedAddresses}`);
    } catch (publicError) {
      setError(publicError.message || "Не удалось получить данные бесплатного публичного источника.");
      setAutomationPhase("Публичный источник временно недоступен");
    } finally {
      setLoading(false);
      setAutomationRunning(false);
    }
  };

  const runFullInvestigation = async () => {
    if (traceNetworkKey !== "TRX") {
      await runPublicChainInvestigation(true);
      return;
    }

    setAutomationRunning(true);
    setLoading(true);
    setError("");
    setReport(null);
    setAutomation(null);
    setCaseStatus("");
    setDepth(6);

    try {
      setAutomationPhase("1/5 · Строю все доступные ветки до 6 переходов");
      const traceResult = await requestTrace({ depth: 6, maxBranches: 12, maxSeeds: 100 });
      setReport(traceResult);

      if (traceResult.status !== "complete") {
        setAutomationPhase("Проверка завершена: подходящие переводы не найдены");
        return;
      }

      setAutomationPhase("2/5 · Проверяю конечные адреса, биржи и известные сервисы");
      const addressesToIdentify = [...new Set([
        ...(traceResult.endpoints || []).map((item) => item.address),
        ...(traceResult.exitPoints || []).map((item) => item.address),
        ...(traceResult.convergences || []).map((item) => item.address),
      ].filter(Boolean))];
      const attribution = addressesToIdentify.length
        ? await attributeAddresses({ addresses: addressesToIdentify, networkKey: "TRX" })
        : { results: [], summary: { total: 0, exchanges: 0, otherKnown: 0, unknown: 0, invalid: 0 } };
      const exchangeHits = attribution.results.filter((item) => item.isExchange);
      const knownServices = attribution.results.filter((item) => item.identified && !item.isExchange);
      const endpointSet = new Set((traceResult.endpoints || []).map((item) => String(item.address || "").toLowerCase()));
      const unknownEndpoints = attribution.results.filter(
        (item) => endpointSet.has(String(item.address || "").toLowerCase()) && item.status === "not_identified"
      );

      setAutomationPhase("3/5 · Ставлю неустановленные конечные адреса под наблюдение");
      const existingWatchAddresses = new Set(watchlistRules.map((rule) => String(rule.address || "").toLowerCase()));
      const watchCandidates = unknownEndpoints
        .filter((item) => !existingWatchAddresses.has(String(item.address || "").toLowerCase()))
        .slice(0, 25);
      const watchResults = saveWatchlistRule
        ? await Promise.allSettled(watchCandidates.map((item) => saveWatchlistRule({
            address: item.address,
            networkName: "TRON",
            eventType: "Любое движение",
            amountLimit: "any",
            assetScope: "stablecoins",
            hideSpamTokens: true,
            channel: "dashboard",
            active: true,
          })))
        : [];
      const watchlistAdded = watchResults.filter((item) => item.status === "fulfilled").length;
      const watchlistFailed = watchResults.filter((item) => item.status === "rejected").length;

      const conclusion = exchangeHits.length
        ? `В маршруте найдено ${exchangeHits.length} адресов с биржевой меткой. Это приоритетные точки для официального запроса; метка определяет организацию, но не ФИО владельца аккаунта.`
        : unknownEndpoints.length
          ? `Биржевая точка выхода пока не установлена. ${unknownEndpoints.length} конечных адресов поставлены на дальнейшую проверку и наблюдение.`
          : `Конечные адреса проверены. Биржевая точка выхода по подключённой базе не найдена; необходимо изучить известные небиржевые сервисы и ограничения отчёта.`;
      const automationResult = {
        generatedAt: new Date().toISOString(),
        reportId: traceResult.reportId,
        rootAddress: traceResult.rootAddress,
        depth: 6,
        factCount: (traceResult.steps || []).length,
        hypothesisCount: (traceResult.steps || []).filter((item) => item.hop > 1).length,
        endpointCount: traceResult.summary.endpointCount || 0,
        convergenceCount: traceResult.summary.convergenceCount || 0,
        exitPointCount: traceResult.summary.exitPointCount || 0,
        exchangeHits,
        knownServices,
        unknownEndpoints,
        watchlistAdded,
        watchlistFailed,
        attributionSummary: attribution.summary,
        conclusion,
        savedCaseId: "",
      };

      setAutomationPhase("4/5 · Сохраняю отчёт и контрольную сумму в дело");
      try {
        const savedCase = await persistTraceAsCase(traceResult, automationResult);
        automationResult.savedCaseId = savedCase.id;
        setCaseStatus(`Полное расследование сохранено: ${savedCase.id}`);
      } catch (saveError) {
        setCaseStatus(`Маршрут построен, но дело не сохранено: ${saveError.message}`);
      }

      setAutomationPhase("5/5 · Полное расследование завершено");
      setAutomation(automationResult);
      addFeed?.(`${traceResult.rootAddress}: полное расследование завершено, бирж ${exchangeHits.length}, наблюдение ${watchlistAdded}`);
    } catch (automationError) {
      setError(automationError.message || "Не удалось выполнить полное расследование.");
      setAutomationPhase("Автоматическая проверка остановлена из-за ошибки");
    } finally {
      setLoading(false);
      setAutomationRunning(false);
    }
  };

  const continueTraceFrom = (targetAddress) => {
    setRootAddress(targetAddress);
    setSeedTxHash("");
    setAmount("");
    setReport(null);
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const traceNetworkKey = traceNetworkForAddress(rootAddress, profile?.networkKey || "ETH");
  const isTron = traceNetworkKey === "TRX";
  const isTraceSupported = traceNetworkKey !== "UNKNOWN";

  return (
    <section className="grid gap-4">
      <AddressConnectionsPanel activeWorkspaceId={activeWorkspaceId} initialAddress={address} profile={profile} />
      <div className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="section-label">Fund tracing · TRON / EVM / Bitcoin</p>
            <h1 className="mt-2 text-xl font-semibold text-zinc-100">Куда ушли деньги</h1>
          </div>
          <div className="rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/10 px-3 py-2 text-xs leading-5 text-sentinel-warning">
            Без чужих API-ключей: TRON — до 6 переходов; EVM и Bitcoin — публичный анализ до 4 уровней.
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-sentinel-green/35 bg-sentinel-green/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold text-sentinel-green">Автоматическое полное расследование</p>
              <p className="mt-1 text-xs leading-6 text-zinc-400">
                {isTron
                  ? "Для TRON один запуск проверяет до 6 переходов и 12 веток, ищет схождение средств и известные точки выхода."
                  : "Для EVM и Bitcoin проверяются доступные ветки до 4 уровней, известные сервисы и возможные точки выхода."}
                {" "}Неустановленные конечные адреса можно автоматически поставить под наблюдение.
              </p>
            </div>
            <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">Факты и версии показываются отдельно</span>
          </div>
        </div>

        <form className="mt-5 grid gap-4" onSubmit={runTrace}>
          <label className="grid gap-2 text-xs text-zinc-500">
            Исходный адрес кошелька
            <input
              className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-600"
              onChange={(event) => setRootAddress(event.target.value)}
              placeholder="T... / 0x... / Bitcoin address"
              value={rootAddress}
            />
          </label>

          <div className={`grid gap-4 ${isTron ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
            {isTron ? (
            <label className="grid gap-2 text-xs text-zinc-500">
              Токен
              <select
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                onChange={(event) => setTokenSymbol(event.target.value)}
                value={tokenSymbol}
              >
                <option value="USDT">USDT</option>
                <option value="USDC">USDC</option>
                <option value="USDD">USDD</option>
              </select>
            </label>
            ) : null}
            <label className="grid gap-2 text-xs text-zinc-500">
              Начало периода
              <input
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                onChange={(event) => setStartAt(event.target.value)}
                type="datetime-local"
                value={startAt}
              />
            </label>
            <label className="grid gap-2 text-xs text-zinc-500">
              Конец периода
              <input
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                onChange={(event) => setEndAt(event.target.value)}
                type="datetime-local"
                value={endAt}
              />
            </label>
          </div>

          {isTron ? <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <label className="grid gap-2 text-xs text-zinc-500">
              Хеш исходной транзакции — необязательно, но делает вывод точнее
              <input
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-600"
                onChange={(event) => setSeedTxHash(event.target.value)}
                placeholder="Например: 128d2349..."
                value={seedTxHash}
              />
            </label>
            <label className="grid gap-2 text-xs text-zinc-500">
              Точная сумма — необязательно
              <input
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1960"
                value={amount}
              />
            </label>
          </div> : (
            <div className="rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
              Для {traceNetworkKey === "BTC" ? "Bitcoin" : "Ethereum/EVM"} приложение загружает доступную публичную историю адреса. Поля точной суммы и хеша нужны только для расширенной трассировки TRON.
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-xs text-zinc-500">
              Глубина проверки: {isTron ? depth : Math.min(depth, 4)} {depth === 1 ? "переход" : "перехода"}
              <input max={isTron ? "6" : "4"} min="1" onChange={(event) => setDepth(Number(event.target.value))} type="range" value={Math.min(depth, isTron ? 6 : 4)} />
            </label>
            {isTron ? <label className="grid gap-2 text-xs text-zinc-500">
              Сколько ждать следующий перевод
              <select
                className="min-h-11 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                onChange={(event) => setHopWindowHours(Number(event.target.value))}
                value={hopWindowHours}
              >
                <option value="6">6 часов</option>
                <option value="24">24 часа</option>
                <option value="72">3 суток</option>
                <option value="168">7 суток</option>
                <option value="720">30 суток</option>
              </select>
            </label> : (
              <div className="grid content-center gap-1 rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs text-zinc-500">
                <span>Определённая сеть</span>
                <strong className="text-sm text-zinc-200">{traceNetworkKey}</strong>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button className={`primary-button min-h-11 px-5 ${loading ? "button-loading" : ""}`} disabled={loading || !isTraceSupported} type="submit">
              {loading ? <LoadingDots label="Проверяю цепочку" /> : "Построить маршрут денег"}
            </button>
            <button className="ghost-button min-h-11 border-sentinel-green/50 px-5 text-sentinel-green" disabled={loading || !isTraceSupported} onClick={runFullInvestigation} type="button">
              {automationRunning ? <LoadingDots label="Полное расследование" /> : "Запустить полное расследование"}
            </button>
            <p className="text-xs leading-5 text-zinc-500">
              {isTron ? "Для дела лучше указать точный период, сумму и хеш первоначального перевода." : "Бесплатные публичные источники могут ограничивать глубину и полноту истории."}
            </p>
          </div>
          {automationPhase ? <p className="text-xs font-medium text-sentinel-green">{automationPhase}</p> : null}
        </form>

        {!isTraceSupported && rootAddress.trim() ? (
          <div className="mt-4 rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/10 p-3 text-sm text-sentinel-warning">
            Формат адреса не распознан. Поддерживаются TRON, Ethereum/EVM и Bitcoin.
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm leading-6 text-sentinel-danger">
            {error}
          </div>
        ) : null}
      </div>

      {publicChainReport ? (
        <div className="panel p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="section-label">PUBLIC MULTICHAIN TRACE · {publicChainReport.summary.networkKey}</p>
              <h2 className="mt-2 text-xl font-semibold text-zinc-100">Маршрут и возможные конечные адреса</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Источник: {publicChainReport.summary.provider}. Запрос выполнен без Infura и без других платных API-ключей.
              </p>
            </div>
            {publicChainReport.summary.reportId ? (
              <span className="rounded border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-500">
                {publicChainReport.summary.reportId}
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ["Проверено адресов", publicChainReport.summary.checkedAddresses],
              ["Транзакций исходного", publicChainReport.summary.rootTransactions],
              ["Связей в цепочке", publicChainReport.summary.chainHops],
              ["Точек выхода", publicChainReport.summary.exitCandidates],
              ["Известных бирж", publicChainReport.summary.exchangeHits.length],
              ["Не установлено", publicChainReport.summary.unknownAddresses.length],
            ].map(([label, value]) => (
              <div className="rounded-lg border border-zinc-800 bg-black p-3" key={label}>
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
                <p className="mt-2 text-xl font-semibold text-zinc-100">{value}</p>
              </div>
            ))}
          </div>

          {publicChainReport.summary.exchangeHits.length ? (
            <div className="mt-5 rounded-lg border border-sentinel-green/35 bg-sentinel-green/5 p-4">
              <h3 className="font-semibold text-zinc-100">Найдены адреса с подтверждённой меткой биржи</h3>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {publicChainReport.summary.exchangeHits.map((item) => (
                  <div className="rounded border border-zinc-800 bg-black p-3" key={item.address}>
                    <p className="font-semibold text-sentinel-green">{item.entity?.name || "Биржа"}</p>
                    <p className="mt-1 break-all font-mono text-xs text-zinc-300">{item.address}</p>
                    <p className="mt-2 text-xs text-zinc-500">
                      Уверенность метки: {item.entity?.confidence ?? "—"}% · источник: {item.entity?.source || "локальная база"}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-zinc-500">
                Метка показывает организацию, но не ФИО клиента. Личность владельца запрашивается у биржи в процессуальном порядке.
              </p>
            </div>
          ) : null}

          <div className="mt-5">
            <div className="flex items-end justify-between gap-3 border-b border-zinc-800 pb-2">
              <div>
                <p className="section-label">CHAIN PATH</p>
                <h3 className="mt-1 font-semibold text-zinc-100">Проверенные адреса по переходам</h3>
              </div>
              <span className="text-xs text-zinc-500">до {traceNetworkKey === "TRX" ? 6 : 4} уровней</span>
            </div>
            {(publicChainReport.analysis?.chain || []).length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-zinc-800 text-xs text-zinc-500">
                    <tr><th className="p-3">Переход</th><th className="p-3">Откуда</th><th className="p-3">Куда</th><th className="p-3">Вероятность</th><th className="p-3">Результат</th></tr>
                  </thead>
                  <tbody>
                    {publicChainReport.analysis.chain.map((item, index) => (
                      <tr className="border-b border-zinc-900 align-top" key={`${item.depth}-${item.address}-${index}`}>
                        <td className="p-3 text-zinc-400">{item.depth}</td>
                        <td className="max-w-[240px] break-all p-3 font-mono text-xs text-zinc-500">{item.parentAddress || rootAddress}</td>
                        <td className="max-w-[240px] break-all p-3 font-mono text-xs text-zinc-200">{item.address}</td>
                        <td className="p-3 text-zinc-400">{item.probability != null ? `${item.probability}%` : "—"}</td>
                        <td className={`p-3 text-xs ${item.error ? "text-sentinel-warning" : "text-sentinel-green"}`}>{item.error || "История загружена"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">В доступной публичной истории следующие адреса не обнаружены.</p>
            )}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-black p-4">
              <h3 className="font-semibold text-zinc-100">Другие известные сервисы</h3>
              {publicChainReport.summary.otherKnown.length ? (
                <div className="mt-3 grid gap-2">
                  {publicChainReport.summary.otherKnown.slice(0, 12).map((item) => (
                    <p className="break-all text-xs text-zinc-400" key={item.address}>{item.entity?.name || "Известный сервис"} · {item.address}</p>
                  ))}
                </div>
              ) : <p className="mt-3 text-sm text-zinc-500">Подтверждённых меток других сервисов не найдено.</p>}
            </div>
            <div className="rounded-lg border border-zinc-800 bg-black p-4">
              <h3 className="font-semibold text-zinc-100">Что пока не доказано</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-500">
                Неизвестных адресов: {publicChainReport.summary.unknownAddresses.length}. Связь транзакций подтверждается блокчейном, но владелец некастодиального кошелька автоматически не устанавливается. Бесплатные источники также могут возвращать неполную историю или временно ограничивать запросы.
              </p>
              {publicChainReport.summary.watchlistAdded ? <p className="mt-2 text-xs text-sentinel-green">Под наблюдение добавлено: {publicChainReport.summary.watchlistAdded}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {report?.status === "not_found" ? (
        <div className="panel p-5">
          <h2 className="text-lg font-semibold text-zinc-100">Переводы не найдены</h2>
          <p className="mt-2 text-sm text-zinc-400">{report.summary.message}</p>
          <ul className="mt-3 grid gap-2 text-sm text-zinc-500">
            {(report.limitations || []).map((item) => <li key={item}>• {item}</li>)}
          </ul>
        </div>
      ) : null}

      {report?.status === "complete" ? (
        <>
          <FundTraceGraph copyValue={copyValue} report={report} />

          {automation ? (
            <div className="panel border-sentinel-green/30 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="section-label">FULL INVESTIGATION · ЗАВЕРШЕНО</p>
                  <h2 className="mt-2 text-xl font-semibold text-zinc-100">Автоматический итог расследования</h2>
                  <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-400">{automation.conclusion}</p>
                </div>
                <button className="primary-button min-h-9 px-3 text-xs" onClick={() => copyValue(automatedInvestigationText(automation), "Автоматический итог скопирован")} type="button">
                  Скопировать итог для следователя
                </button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                {[
                  ["Транзакций-фактов", automation.factCount],
                  ["Вероятных связей", automation.hypothesisCount],
                  ["Конечных адресов", automation.endpointCount],
                  ["Схождений веток", automation.convergenceCount],
                  ["Бирж", automation.exchangeHits.length],
                  ["Под наблюдением", automation.watchlistAdded],
                ].map(([label, value]) => (
                  <div className="rounded-lg border border-zinc-800 bg-black p-3" key={label}>
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
                    <p className="mt-2 text-xl font-semibold text-zinc-100">{value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="rounded-lg border border-sentinel-green/30 bg-sentinel-green/5 p-4">
                  <h3 className="font-semibold text-zinc-100">Биржи и кастодиальные сервисы</h3>
                  {automation.exchangeHits.length ? (
                    <div className="mt-3 grid gap-3">
                      {automation.exchangeHits.map((item) => {
                        const exitPoint = (report.exitPoints || []).find((candidate) => candidate.address.toLowerCase() === item.address.toLowerCase());
                        return (
                          <div className="rounded border border-zinc-800 bg-black p-3" key={item.address}>
                            <p className="font-semibold text-sentinel-green">{item.entity.name}</p>
                            <p className="mt-1 break-all font-mono text-xs text-zinc-400">{item.address}</p>
                            <p className="mt-2 text-xs leading-5 text-zinc-500">Метка {item.entity.confidence}% · источник {item.entity.source}</p>
                            {exitPoint ? <button className="ghost-button mt-3 min-h-8 px-3 text-xs" onClick={() => copyValue(investigatorExitRequestText(report, exitPoint), "Черновик запроса бирже скопирован")} type="button">Скопировать запрос бирже</button> : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : <p className="mt-3 text-sm leading-6 text-zinc-500">Биржевая точка по подключённой базе не найдена.</p>}
                </div>

                <div className="rounded-lg border border-sentinel-warning/30 bg-sentinel-warning/5 p-4">
                  <h3 className="font-semibold text-zinc-100">Неустановленные конечные адреса</h3>
                  {automation.unknownEndpoints.length ? (
                    <div className="mt-3 grid gap-2">
                      {automation.unknownEndpoints.slice(0, 25).map((item) => (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-black p-3" key={item.address}>
                          <span className="break-all font-mono text-xs text-zinc-300">{item.address}</span>
                          <span className="text-[11px] text-sentinel-warning">Наблюдение / владелец не установлен</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="mt-3 text-sm leading-6 text-zinc-500">Неустановленных конечных адресов в этом отчёте нет.</p>}
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 text-xs leading-6 text-zinc-500">
                Дело: {automation.savedCaseId || "не сохранено"} · SHA-256 отчёта: <span className="break-all font-mono text-zinc-400">{report.evidenceManifest?.reportSha256 || "не сформирован"}</span>.
                Автоматизация устанавливает маршрут и организацию по метке, но не подменяет официальный ответ биржи и доказательство личности владельца.
              </div>
            </div>
          ) : null}

          <div className="panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="section-label">Ответ по делу</p>
                <h2 className="mt-2 text-xl font-semibold text-zinc-100">Краткий вывод понятным языком</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="ghost-button min-h-9 px-3 text-xs" onClick={() => copyValue(investigatorTraceText(report), "Отчёт скопирован")} type="button">
                  Копировать текст отчёта
                </button>
                <button className="ghost-button min-h-9 px-3 text-xs" onClick={downloadTextReport} type="button">
                  Скачать TXT
                </button>
                <button className="ghost-button min-h-9 px-3 text-xs" onClick={downloadCsvReport} type="button">
                  Скачать CSV
                </button>
                <button className="ghost-button min-h-9 px-3 text-xs" onClick={downloadReport} type="button">
                  Скачать JSON
                </button>
                <button className="ghost-button min-h-9 px-3 text-xs" onClick={downloadEvidencePackage} type="button">
                  Пакет доказательств
                </button>
                <button className="primary-button min-h-9 px-3 text-xs" onClick={saveTraceAsCase} type="button">
                  Сохранить в дело
                </button>
              </div>
            </div>
            {copied ? <p className="mt-2 text-xs text-sentinel-green">{copied}</p> : null}
            {caseStatus ? <p className="mt-2 text-xs text-sentinel-green">{caseStatus}</p> : null}
            <p className="mt-4 rounded-lg border border-sentinel-green/30 bg-sentinel-green/10 p-4 text-sm leading-7 text-zinc-200">
              {report.summary.conclusion}
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5 2xl:grid-cols-10">
              {[
                ["Найдено исходящих", report.summary.seedTransfersFound],
                ["Сумма для трассировки", `${report.summary.seedAmountFormatted} ${report.summary.tokenSymbol}`],
                ["Прямых получателей", report.summary.directRecipients],
                ["Последних адресов", report.summary.endpointCount],
                ["Известных организаций", report.summary.knownEntityEndpoints],
                ["Альтернативных кандидатов", report.summary.alternativeCandidateCount || 0],
                ["Точек сбора веток", report.summary.convergenceCount || 0],
                ["Точек выхода", report.summary.exitPointCount || 0],
                ["Смен актива", report.summary.assetTransitionCandidateCount || 0],
                ["Покрытие маршрута", `${Number(report.summary.tracedCoveragePercent || 0).toFixed(2)}%`],
              ].map(([label, value]) => (
                <div className="rounded-lg border border-zinc-800 bg-black p-3" key={label}>
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-2 text-lg font-semibold text-zinc-100">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <p className="section-label">Рассеивание → сбор</p>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">Где несколько веток снова сошлись</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
              Система группирует подтверждённые переводы, если деньги от двух или более прямых получателей исходного адреса пришли на один общий адрес. Такой адрес становится приоритетной точкой для проверки владельца и дальнейшего движения средств.
            </p>

            {(report.convergences || []).length ? (
              <div className="mt-4 grid gap-4">
                {(report.convergences || []).map((convergence) => (
                  <article className="rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/5 p-4" key={convergence.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded border border-sentinel-warning/50 px-2 py-1 text-[11px] font-semibold text-sentinel-warning">
                            Возможная точка сбора
                          </span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">Hop {convergence.hop}</span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">
                            Сошлось веток: {convergence.branchCount}
                          </span>
                        </div>
                        <button className="mt-3 break-all text-left font-mono text-sm font-semibold text-zinc-100 hover:text-white" onClick={() => copyValue(convergence.address, "Адрес точки сбора скопирован")} type="button">
                          {convergence.address}
                        </button>
                        <p className="mt-3 text-sm leading-6 text-zinc-300">
                          К этому адресу отнесено <strong className="text-zinc-100">{convergence.attributedAmountFormatted} {convergence.tokenSymbol}</strong> — {Number(convergence.seedCoveragePercent || 0).toFixed(2)}% исходной суммы. Переводы пришли с {convergence.sourceCount} разных адресов.
                        </p>
                        <p className="mt-2 text-xs leading-5 text-zinc-500">{convergence.explanation}</p>
                        {convergence.entity ? (
                          <div className="mt-3 rounded border border-sentinel-green/30 bg-sentinel-green/10 p-3 text-sm text-zinc-300">
                            Получатель отмечен в базе: <strong className="text-zinc-100">{convergence.entity.name}</strong> · {convergence.entity.category} · источник {convergence.entity.source}
                          </div>
                        ) : (
                          <div className="mt-3 rounded border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
                            Владелец адреса не установлен. Если это депозит биржи, следователю нужен официальный запрос бирже по адресу, хешам и времени переводов.
                          </div>
                        )}
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-black px-4 py-3 text-right">
                        <p className="text-xs text-zinc-500">Минимальная уверенность связей</p>
                        <p className={`mt-1 text-xl font-semibold ${convergence.confidence >= 70 ? "text-sentinel-green" : convergence.confidence >= 50 ? "text-sentinel-warning" : "text-sentinel-danger"}`}>{convergence.confidence}%</p>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-[980px] w-full text-left text-xs">
                        <thead className="border-b border-zinc-800 text-zinc-500">
                          <tr>
                            <th className="py-3 pr-4">Ветка началась с</th>
                            <th className="py-3 pr-4">Кто отправил в точку сбора</th>
                            <th className="py-3 pr-4">Сумма</th>
                            <th className="py-3 pr-4">Время</th>
                            <th className="py-3">Транзакция</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(convergence.transactions || []).map((transaction) => (
                            <tr className="border-b border-zinc-900 align-top" key={`${convergence.id}-${transaction.transactionHash}`}>
                              <td className="max-w-[220px] py-3 pr-4 break-all font-mono text-zinc-500">{transaction.originRecipientAddress}</td>
                              <td className="max-w-[220px] py-3 pr-4 break-all font-mono text-zinc-300">{transaction.sourceAddress}</td>
                              <td className="py-3 pr-4 text-zinc-200">{transaction.transactionAmountFormatted} {transaction.tokenSymbol}</td>
                              <td className="py-3 pr-4 text-zinc-400">{new Date(transaction.timestamp).toLocaleString("ru-RU")}</td>
                              <td className="max-w-[220px] py-3">
                                {transaction.explorerUrl ? (
                                  <a className="break-all font-mono text-zinc-500 hover:text-zinc-100" href={transaction.explorerUrl} rel="noreferrer" target="_blank">{transaction.transactionHash}</a>
                                ) : (
                                  <button className="break-all text-left font-mono text-zinc-500 hover:text-zinc-100" onClick={() => copyValue(transaction.transactionHash, "Хеш скопирован")} type="button">{transaction.transactionHash}</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 text-sm leading-6 text-zinc-400">
                В пределах выбранных дат, окна и трёх переходов общий адрес для двух или более прослеженных веток не найден. Это не означает, что сбора не было: он мог произойти позже, глубже либо через обмен токена или другую сеть.
              </div>
            )}
          </div>

          <div className="panel p-5">
            <p className="section-label">Cash-out / service attribution</p>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">Точки выхода и известные организации</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
              Здесь показываются адреса маршрута, совпавшие с подключённой базой бирж, сервисов, мостов, миксеров и риск-организаций. Сам перевод является фактом блокчейна, а метка организации должна подтверждаться указанным источником.
            </p>

            {(report.exitPoints || []).length ? (
              <div className="mt-4 grid gap-4">
                {(report.exitPoints || []).map((exitPoint) => (
                  <article className="rounded-lg border border-sentinel-green/30 bg-sentinel-green/5 p-4" key={exitPoint.id}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded border border-sentinel-green/40 px-2 py-1 text-[11px] font-semibold text-sentinel-green">{traceExitTypeLabel(exitPoint.exitType)}</span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">Hop {exitPoint.hop}</span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">метка {exitPoint.labelConfidence}%</span>
                        </div>
                        <h3 className="mt-3 text-base font-semibold text-zinc-100">{exitPoint.entity?.name || "Известная организация"}</h3>
                        <button className="mt-2 break-all text-left font-mono text-sm text-zinc-300 hover:text-white" onClick={() => copyValue(exitPoint.address, "Адрес скопирован")} type="button">{exitPoint.address}</button>
                        <p className="mt-3 text-sm text-zinc-300">Отнесено к маршруту: <strong>{exitPoint.attributedAmountFormatted} {exitPoint.tokenSymbol}</strong> · транзакций: {exitPoint.transactionCount} · уверенность маршрута: {exitPoint.routeConfidence}%</p>
                        <p className="mt-2 text-xs leading-5 text-zinc-500">Источник метки: {exitPoint.entity?.source || "не указан"}. {exitPoint.evidenceStatement}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button className="ghost-button min-h-9 px-3 text-xs" onClick={() => copyValue(investigatorExitRequestText(report, exitPoint), "Черновик запроса скопирован")} type="button">Скопировать запрос</button>
                        <button className="ghost-button min-h-9 px-3 text-xs" disabled={watchingAddress === exitPoint.address} onClick={() => addTraceAddressToWatchlist(exitPoint.address)} type="button">Наблюдать</button>
                        <button className="primary-button min-h-9 px-3 text-xs" onClick={() => continueTraceFrom(exitPoint.address)} type="button">Продолжить отсюда</button>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2">
                      {(exitPoint.transactions || []).map((transaction) => (
                        <div className="rounded border border-zinc-800 bg-black p-3 text-xs text-zinc-400" key={`${exitPoint.id}-${transaction.transactionHash}`}>
                          <p>{new Date(transaction.timestamp).toLocaleString("ru-RU")} · {transaction.transactionAmountFormatted} {transaction.tokenSymbol}</p>
                          <p className="mt-1 break-all font-mono text-zinc-600">{transaction.sourceAddress} → {transaction.destinationAddress}</p>
                          {transaction.explorerUrl ? <a className="mt-1 block break-all font-mono text-zinc-500 hover:text-zinc-100" href={transaction.explorerUrl} rel="noreferrer" target="_blank">tx {transaction.transactionHash}</a> : null}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 text-sm leading-6 text-zinc-400">
                Подтверждённая по подключённой базе точка выхода не найдена. Продолжите трассировку от последних адресов и пополняйте базу только метками с проверяемым источником.
              </div>
            )}
          </div>

          <div className="panel p-5">
            <p className="section-label">Asset transition</p>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">Возможная смена стейблкоина</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
              Если после поступления USDT обнаружен близкий по сумме перевод USDC или USDD, система сохраняет его как кандидата смены актива. Без разбора событий смарт-контракта это версия, а не подтверждённый обмен.
            </p>
            {(report.assetTransitions || []).length ? (
              <div className="mt-4 grid gap-3">
                {(report.assetTransitions || []).map((transition) => (
                  <article className="rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/5 p-4" key={transition.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded border border-sentinel-warning/40 px-2 py-1 text-[11px] text-sentinel-warning">{transition.fromTokenSymbol} → {transition.toTokenSymbol}</span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">оценка {transition.confidence}%</span>
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">совпадение {Number(transition.similarityPercent || 0).toFixed(1)}%</span>
                        </div>
                        <p className="mt-3 text-sm text-zinc-200">{transition.transactionAmountFormatted} {transition.toTokenSymbol} через {transition.delayMinutes} мин.</p>
                        <p className="mt-2 break-all font-mono text-xs text-zinc-500">{transition.sourceAddress} → {transition.destinationAddress}</p>
                        <p className="mt-2 text-xs leading-5 text-zinc-600">{transition.explanation}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {transition.explorerUrl ? <a className="ghost-button inline-flex min-h-9 items-center px-3 text-xs" href={transition.explorerUrl} rel="noreferrer" target="_blank">Открыть tx</a> : null}
                        <button className="primary-button min-h-9 px-3 text-xs" onClick={() => { setTokenSymbol(transition.toTokenSymbol); continueTraceFrom(transition.destinationAddress); }} type="button">Продолжить в {transition.toTokenSymbol}</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 text-sm text-zinc-400">Кандидаты смены USDT/USDC/USDD в выбранном окне не найдены.</div>
            )}
          </div>

          {(report.comparisons || []).length ? (
            <div className="panel p-5">
              <p className="section-label">Проверка альтернатив</p>
              <h2 className="mt-2 text-lg font-semibold text-zinc-100">Какие ещё переводы могли быть продолжением</h2>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
                Приложение обязано показывать не только выбранную моделью транзакцию, но и конкурирующие варианты. Если сильных совпадений несколько, установить единственного получателя автоматически нельзя.
              </p>

              <div className="mt-4 grid gap-4">
                {(report.comparisons || []).map((comparison) => (
                  <article className="rounded-lg border border-zinc-800 bg-black p-4" key={comparison.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">Hop {comparison.hop}</span>
                          <span className={`rounded border px-2 py-1 text-[11px] ${comparison.activity?.strongMatches > 1 ? "border-sentinel-danger/50 text-sentinel-danger" : "border-sentinel-green/40 text-sentinel-green"}`}>
                            Сильных совпадений: {comparison.activity?.strongMatches || 0}
                          </span>
                          {comparison.providerTruncated ? (
                            <span className="rounded border border-sentinel-warning/40 px-2 py-1 text-[11px] text-sentinel-warning">История провайдера неполная</span>
                          ) : null}
                        </div>
                        <p className="mt-3 text-sm text-zinc-300">
                          На адрес поступило <strong className="text-zinc-100">{comparison.receivedAmountFormatted} {comparison.tokenSymbol}</strong>. Проверяется дальнейшее движение с адреса:
                        </p>
                        <button className="mt-1 break-all text-left font-mono text-xs text-zinc-500 hover:text-zinc-200" onClick={() => copyValue(comparison.sourceAddress, "Адрес скопирован")} type="button">
                          {comparison.sourceAddress}
                        </button>
                      </div>
                      <div className="text-right text-xs leading-5 text-zinc-500">
                        <p>Входящих в окне: {comparison.activity?.incomingTransfersInWindow || 0}</p>
                        <p>Исходящих в окне: {comparison.activity?.outgoingTransfersInWindow || 0}</p>
                        <p>Показано: {comparison.displayedCandidates} из {comparison.totalCandidates}</p>
                      </div>
                    </div>

                    {comparison.activity?.strongMatches > 1 ? (
                      <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-xs leading-6 text-sentinel-danger">
                        Внимание: найдено несколько переводов с близкой суммой и временем. Выбранный вариант — только аналитическая версия. Для вывода по делу нужны дополнительные сведения.
                      </div>
                    ) : null}

                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-[1050px] w-full text-left text-xs">
                        <thead className="border-b border-zinc-800 text-zinc-500">
                          <tr>
                            <th className="py-3 pr-4">№</th>
                            <th className="py-3 pr-4">Результат модели</th>
                            <th className="py-3 pr-4">Адрес получателя</th>
                            <th className="py-3 pr-4">Сумма</th>
                            <th className="py-3 pr-4">Через</th>
                            <th className="py-3 pr-4">Совпадение суммы</th>
                            <th className="py-3 pr-4">Оценка</th>
                            <th className="py-3">Хеш</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(comparison.candidates || []).map((candidate) => (
                            <tr className={`border-b border-zinc-900 align-top ${candidate.selected ? "bg-sentinel-green/5" : ""}`} key={`${comparison.id}-${candidate.transactionHash}-${candidate.rank}`}>
                              <td className="py-4 pr-4 text-zinc-500">{candidate.rank}</td>
                              <td className="py-4 pr-4">
                                <span className={`rounded border px-2 py-1 text-[11px] font-semibold ${candidate.selected ? "border-sentinel-green/50 text-sentinel-green" : "border-zinc-700 text-zinc-500"}`}>
                                  {candidate.selected ? "Выбран моделью" : "Альтернатива"}
                                </span>
                                <p className="mt-2 text-[11px] text-zinc-600">
                                  {candidate.strongMatch ? "Близкая сумма и короткая задержка" : "Хронологический кандидат"}
                                </p>
                              </td>
                              <td className="max-w-[230px] py-4 pr-4">
                                <button className="break-all text-left font-mono text-zinc-300 hover:text-white" onClick={() => copyValue(candidate.destinationAddress, "Адрес скопирован")} type="button">
                                  {candidate.destinationAddress}
                                </button>
                                {candidate.destinationEntity ? <p className="mt-2 text-sentinel-green">{candidate.destinationEntity.name}</p> : null}
                              </td>
                              <td className="py-4 pr-4 text-zinc-300">{candidate.transactionAmountFormatted} {candidate.tokenSymbol}</td>
                              <td className="py-4 pr-4 text-zinc-400">{candidate.delayMinutes} мин.</td>
                              <td className="py-4 pr-4 text-zinc-300">{Number(candidate.similarityPercent || 0).toFixed(1)}%</td>
                              <td className="py-4 pr-4">
                                <span className={candidate.confidence >= 70 ? "text-sentinel-green" : candidate.confidence >= 50 ? "text-sentinel-warning" : "text-sentinel-danger"}>{candidate.confidence}%</span>
                              </td>
                              <td className="max-w-[220px] py-4">
                                <button className="break-all text-left font-mono text-zinc-600 hover:text-zinc-200" onClick={() => copyValue(candidate.transactionHash, "Хеш скопирован")} type="button">
                                  {candidate.transactionHash}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          <div className="panel p-5">
            <p className="section-label">Получатели</p>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">У кого средства оказались в пределах этой проверки</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Если организация не подписана, это означает только «не установлена по подключённой базе», а не отсутствие владельца.
            </p>
            {(report.terminalAddresses || []).length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full min-w-[1050px] text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-black text-zinc-500">
                    <tr>
                      <th className="p-3">Конечный адрес</th>
                      <th className="p-3">Последний переход</th>
                      <th className="p-3">Количество путей</th>
                      <th className="p-3">Отнесённая сумма</th>
                      <th className="p-3">Биржа / организация</th>
                      <th className="p-3">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.terminalAddresses.map((terminal) => (
                      <tr className={`border-b border-zinc-900 align-top ${terminal.isExchange ? "bg-sentinel-warning/5" : ""}`} key={terminal.address}>
                        <td className="max-w-[280px] break-all p-3 font-mono text-zinc-200">
                          <button className="text-left hover:text-white" onClick={() => copyValue(terminal.address, "Конечный адрес скопирован")} type="button">{terminal.address}</button>
                        </td>
                        <td className="p-3 text-zinc-400">Hop {terminal.maxHop}</td>
                        <td className="p-3 text-zinc-400">{terminal.pathCount}{terminal.originBranchCount > 1 ? ` · веток ${terminal.originBranchCount}` : ""}</td>
                        <td className="p-3 text-zinc-200">{terminal.amountFormatted} {terminal.tokenSymbol}</td>
                        <td className="p-3">
                          {terminal.entity ? (
                            <div>
                              <p className={terminal.isExchange ? "font-semibold text-sentinel-warning" : "font-semibold text-sentinel-green"}>{terminal.entity.name}</p>
                              <p className="mt-1 text-[11px] text-zinc-600">{traceExitTypeLabel(terminal.exitType)} · метка {terminal.entity.confidence}%</p>
                            </div>
                          ) : <span className="text-zinc-600">Не установлена</span>}
                        </td>
                        <td className="p-3 text-zinc-400">{traceEndpointStatus(terminal.status)} · маршрут {terminal.confidence}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="mt-4 grid gap-3">
              {(report.endpoints || []).map((endpoint) => (
                <article className="rounded-lg border border-zinc-800 bg-black p-4" key={endpoint.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">Hop {endpoint.hop}</span>
                        <span className={`rounded border px-2 py-1 text-[11px] ${endpoint.entity ? "border-sentinel-green/50 text-sentinel-green" : "border-sentinel-warning/40 text-sentinel-warning"}`}>
                          {traceEndpointStatus(endpoint.status)}
                        </span>
                      </div>
                      <p className="mt-3 break-all font-mono text-sm text-zinc-100">{endpoint.address}</p>
                      <p className="mt-2 text-sm text-zinc-300">Отнесено к маршруту: {endpoint.amountFormatted} {endpoint.tokenSymbol}</p>
                      <p className={`mt-2 text-xs font-semibold ${endpoint.confidence >= 70 ? "text-sentinel-green" : endpoint.confidence >= 50 ? "text-sentinel-warning" : "text-sentinel-danger"}`}>
                        Уверенность всего маршрута: {endpoint.confidence}%
                        {endpoint.confidence < 50 ? " · нельзя считать установленным единственным получателем" : ""}
                      </p>
                      {endpoint.entity ? (
                        <div className="mt-3 rounded border border-sentinel-green/30 bg-sentinel-green/10 p-3 text-sm leading-6 text-zinc-300">
                          <strong className="text-zinc-100">{endpoint.entity.name}</strong> · {endpoint.entity.category} · уверенность базы {endpoint.entity.confidence}%
                          <br />Источник метки: {endpoint.entity.source}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs leading-5 text-zinc-500">Владелец адреса по локальной базе не установлен. Нужна проверка биржевых меток и официальный запрос провайдеру.</p>
                      )}
                      <p className="mt-2 text-xs leading-5 text-zinc-600">{endpoint.note}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="ghost-button min-h-8 px-3 text-xs" onClick={() => copyValue(endpoint.address, "Адрес скопирован")} type="button">Копировать</button>
                      <button className="ghost-button min-h-8 px-3 text-xs" disabled={watchingAddress === endpoint.address} onClick={() => addTraceAddressToWatchlist(endpoint.address)} type="button">Наблюдать</button>
                      <button className="primary-button min-h-8 px-3 text-xs" onClick={() => continueTraceFrom(endpoint.address)} type="button">Продолжить</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <p className="section-label">Цепочка переводов</p>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">Полный маршрут по переходам</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[1180px] w-full text-left text-xs">
                <thead className="border-b border-zinc-800 text-zinc-500">
                  <tr>
                    <th className="py-3 pr-4">Переход</th>
                    <th className="py-3 pr-4">Откуда</th>
                    <th className="py-3 pr-4">Куда</th>
                    <th className="py-3 pr-4">Сумма транзакции</th>
                    <th className="py-3 pr-4">Отнесено к маршруту</th>
                    <th className="py-3 pr-4">Время</th>
                    <th className="py-3 pr-4">Статус связи</th>
                    <th className="py-3">Хеш</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.steps || []).map((step) => (
                    <tr className="border-b border-zinc-900 align-top" key={step.id}>
                      <td className="py-4 pr-4 font-semibold text-zinc-200">Hop {step.hop}</td>
                      <td className="max-w-[220px] py-4 pr-4"><button className="break-all text-left font-mono text-zinc-300 hover:text-white" onClick={() => copyValue(step.sourceAddress, "Адрес скопирован")} type="button">{step.sourceAddress}</button></td>
                      <td className="max-w-[220px] py-4 pr-4"><button className="break-all text-left font-mono text-zinc-300 hover:text-white" onClick={() => copyValue(step.destinationAddress, "Адрес скопирован")} type="button">{step.destinationAddress}</button></td>
                      <td className="py-4 pr-4 text-zinc-300">{step.transactionAmountFormatted} {step.tokenSymbol}</td>
                      <td className="py-4 pr-4 text-zinc-300">{step.attributedAmountFormatted} {step.tokenSymbol}</td>
                      <td className="py-4 pr-4 text-zinc-500">{new Date(step.timestamp).toLocaleString("ru-RU")}</td>
                      <td className="py-4 pr-4">
                        {step.relation === "direct_fact" ? (
                          <span className="rounded border border-sentinel-green/50 px-2 py-1 text-sentinel-green">Факт · 100%</span>
                        ) : (
                          <div>
                            <span className="rounded border border-sentinel-warning/40 px-2 py-1 text-sentinel-warning">Вероятная · {step.confidence}%</span>
                            <p className="mt-2 max-w-[210px] leading-5 text-zinc-600">Совпадение суммы {Number(step.similarityPercent || 0).toFixed(1)}% · через {step.delayMinutes} мин.</p>
                          </div>
                        )}
                      </td>
                      <td className="max-w-[200px] py-4"><button className="break-all text-left font-mono text-zinc-500 hover:text-zinc-200" onClick={() => copyValue(step.transactionHash, "Хеш скопирован")} type="button">{step.transactionHash}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="panel p-5">
              <p className="section-label">Установлено</p>
              <h3 className="mt-2 font-semibold text-zinc-100">Факты блокчейна</h3>
              <ul className="mt-4 grid gap-3 text-xs leading-6 text-zinc-400">
                {(report.facts || []).slice(0, 20).map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}
              </ul>
            </div>
            <div className="panel p-5">
              <p className="section-label">Аналитическая версия</p>
              <h3 className="mt-2 font-semibold text-zinc-100">Вероятное продолжение маршрута</h3>
              <ul className="mt-4 grid gap-3 text-xs leading-6 text-zinc-400">
                {(report.hypotheses || []).length
                  ? report.hypotheses.slice(0, 20).map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)
                  : <li>Дальнейшие переводы в заданном окне не установлены.</li>}
              </ul>
            </div>
            <div className="panel p-5">
              <p className="section-label">Не доказано автоматически</p>
              <h3 className="mt-2 font-semibold text-zinc-100">Что нужно подтвердить</h3>
              <ul className="mt-4 grid gap-3 text-xs leading-6 text-zinc-400">
                {(report.limitations || []).map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}
              </ul>
            </div>
          </div>

          <div className="panel p-5 text-xs leading-6 text-zinc-500">
            <p className="section-label">Методика</p>
            <p className="mt-3"><strong className="text-zinc-300">Hop 1:</strong> {report.methodology.directEvidence}</p>
            <p><strong className="text-zinc-300">Hop 2–3:</strong> {report.methodology.onwardModel}</p>
            <p><strong className="text-zinc-300">Уверенность:</strong> {report.methodology.confidence}</p>
            <p className="mt-2">Отчёт {report.reportId} · создан {new Date(report.generatedAt).toLocaleString("ru-RU")} · источник {report.provider}</p>
          </div>
        </>
      ) : null}
    </section>
  );
}

function TransactionAddressButton({ address, currentAddress, onOpenAddress }) {
  if (!address) {
    return <span className="text-zinc-700">—</span>;
  }

  const isCurrent = String(address).toLowerCase() === String(currentAddress || "").toLowerCase();

  return (
    <button
      aria-label={`Открыть транзакции кошелька ${address}`}
      className={`group inline-flex max-w-[190px] items-center gap-1.5 text-left font-mono text-xs transition-colors ${
        isCurrent ? "text-zinc-500 hover:text-zinc-200" : "text-sentinel-green hover:text-white"
      }`}
      onClick={() => onOpenAddress?.(address)}
      title={`${address}\nНажмите, чтобы открыть все транзакции этого кошелька`}
      type="button"
    >
      <span className="truncate">{address}</span>
      <span aria-hidden="true" className="shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5">→</span>
    </button>
  );
}

function TransactionEvidenceCard({ transaction, onClose }) {
  const tx = transaction?.normalizedV2;
  if (!tx) return null;
  const isBitcoin = tx.network?.family === "utxo";

  return (
    <section className="mt-4 rounded-lg border border-sentinel-green/30 bg-sentinel-green/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="section-label">Карточка транзакции · подтверждаемые данные</p>
          <h3 className="mt-2 break-all font-mono text-sm font-semibold text-zinc-100">{tx.txHash}</h3>
        </div>
        <button aria-label="Закрыть карточку" className="ghost-button grid h-9 w-9 place-items-center" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="panel-subtle p-3"><p className="text-xs text-zinc-500">Сеть</p><p className="mt-1 text-sm text-zinc-200">{tx.network?.name}</p></div>
        <div className="panel-subtle p-3"><p className="text-xs text-zinc-500">Сумма</p><p className="mt-1 text-sm text-zinc-200">{tx.amount?.value} {tx.amount?.symbol}</p></div>
        <div className="panel-subtle p-3"><p className="text-xs text-zinc-500">Статус</p><p className="mt-1 text-sm text-zinc-200">{tx.status}</p></div>
        <div className="panel-subtle p-3"><p className="text-xs text-zinc-500">Блок и время</p><p className="mt-1 text-sm text-zinc-200">{tx.block?.number ?? "не указан"}</p><p className="text-xs text-zinc-500">{tx.timestamp ? new Date(tx.timestamp).toLocaleString("ru-RU") : "время не указано"}</p></div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-zinc-800 bg-black p-3">
          <p className="text-xs font-semibold text-zinc-300">Отправители</p>
          {(tx.fromAddresses || []).length ? tx.fromAddresses.map((value) => <p className="mt-2 break-all font-mono text-xs text-zinc-500" key={value}>{value}</p>) : <p className="mt-2 text-xs text-zinc-600">Не указан провайдером</p>}
        </div>
        <div className="rounded-md border border-zinc-800 bg-black p-3">
          <p className="text-xs font-semibold text-zinc-300">Получатели</p>
          {(tx.toAddresses || []).length ? tx.toAddresses.map((value) => <p className="mt-2 break-all font-mono text-xs text-zinc-500" key={value}>{value}</p>) : <p className="mt-2 text-xs text-zinc-600">Не указан провайдером</p>}
        </div>
      </div>

      {isBitcoin ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-zinc-800 bg-black p-3">
            <p className="text-xs font-semibold text-zinc-300">Bitcoin inputs · {(tx.inputs || []).length}</p>
            {(tx.inputs || []).slice(0, 20).map((input) => <p className="mt-2 break-all font-mono text-[11px] text-zinc-500" key={`${input.previousTxHash}-${input.index}`}>{input.addresses?.join(", ") || "адрес не раскрыт"} · {input.value?.raw || "0"} sat</p>)}
          </div>
          <div className="rounded-md border border-zinc-800 bg-black p-3">
            <p className="text-xs font-semibold text-zinc-300">Bitcoin outputs · {(tx.outputs || []).length}</p>
            {(tx.outputs || []).slice(0, 20).map((output) => <p className="mt-2 break-all font-mono text-[11px] text-zinc-500" key={output.index}>{output.addresses?.join(", ") || "адрес не раскрыт"} · {output.value?.raw || "0"} sat</p>)}
          </div>
          <p className="lg:col-span-2 text-xs leading-5 text-sentinel-warning">Факт: показаны все входы и выходы. Предполагаемый адрес сдачи автоматически владельцу не приписывается.</p>
        </div>
      ) : null}

      <div className="mt-4 rounded-md border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
        <p><span className="text-zinc-300">Источник:</span> {tx.provenance?.provider || "не указан"}</p>
        <p><span className="text-zinc-300">Получено:</span> {tx.provenance?.retrievedAt ? new Date(tx.provenance.retrievedAt).toLocaleString("ru-RU") : "не указано"}</p>
        <p className="break-all"><span className="text-zinc-300">SHA-256 исходного ответа:</span> {tx.provenance?.rawResponseHash || "не сохранён"}</p>
        <p className="break-all"><span className="text-zinc-300">ID исходного ответа:</span> {tx.provenance?.rawResponseId || "не сохранён"}</p>
        <p className="mt-2 text-zinc-600">Эти поля подтверждают источник blockchain-данных, но сами по себе не доказывают личность владельца адреса.</p>
      </div>
    </section>
  );
}

function TransactionsPanel({ address, profile, onOpenAddress }) {
  const [transactions, setTransactions] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [networkFilter, setNetworkFilter] = useState(defaultProfileNetwork(profile));
  const [page, setPage] = useState(1);
  const [fingerprint, setFingerprint] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [providerErrors, setProviderErrors] = useState([]);
  const [scannedNetworks, setScannedNetworks] = useState([]);
  const [skippedNetworks, setSkippedNetworks] = useState([]);
  const [includeDust, setIncludeDust] = useState(false);
  const [dustInfo, setDustInfo] = useState({ count: 0, minAmount: "1 TRX" });
  const [directionFilter, setDirectionFilter] = useState("all");
  const [riskOnly, setRiskOnly] = useState(false);
  const [stablecoinOnly, setStablecoinOnly] = useState(false);
  const [hideSpamTokens, setHideSpamTokens] = useState(true);
  const [txSearch, setTxSearch] = useState("");
  const [cacheInfo, setCacheInfo] = useState(null);
  const [dataQuality, setDataQuality] = useState(null);
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    loadRequestIdRef.current += 1;
    setNetworkFilter(defaultProfileNetwork(profile));
    setTransactions([]);
    setPage(1);
    setFingerprint("");
    setHasMore(false);
    setError("");
    setProviderMessage("");
    setProviderErrors([]);
    setScannedNetworks([]);
    setSkippedNetworks([]);
    setIncludeDust(false);
    setDustInfo({ count: 0, minAmount: "1 TRX" });
    setCacheInfo(null);
    setDataQuality(null);
    setAnalysis(null);
    setSelectedTransaction(null);
  }, [address, profile.networkKey]);

  useEffect(() => {
    setTransactions([]);
    setPage(1);
    setFingerprint("");
    setHasMore(false);
    setError("");
    setProviderMessage("");
    setProviderErrors([]);
    setScannedNetworks([]);
    setSkippedNetworks([]);
    setDustInfo({ count: 0, minAmount: "1 TRX" });
    setCacheInfo(null);
    setDataQuality(null);
    setAnalysis(null);
    setSelectedTransaction(null);
  }, [networkFilter, includeDust]);

  const availableNetworks = profileNetworkOptions(profile);
  const filteredTransactions = useMemo(() => {
    const query = txSearch.trim().toLowerCase();
    const flagsByHash = analysis?.transactionFlags || {};

    return transactions.filter((tx) => {
      const flags = flagsByHash[tx.hash] || [];
      const matchesDirection = directionFilter === "all" || tx.direction === directionFilter;
      const matchesRisk = !riskOnly || flags.length > 0;
      const matchesSpam = !hideSpamTokens || !tx.isSpamToken;
      const matchesStablecoin =
        !stablecoinOnly ||
        stablecoinTokenSymbols.has(String(tx.tokenSymbol || "").toUpperCase());
      const matchesQuery =
        !query ||
        [tx.hash, tx.from, tx.to, tx.networkName, tx.value]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));

      return matchesDirection && matchesRisk && matchesSpam && matchesStablecoin && matchesQuery;
    });
  }, [analysis, directionFilter, hideSpamTokens, riskOnly, stablecoinOnly, transactions, txSearch]);
  const tableStats = useMemo(() => {
    const flagsByHash = analysis?.transactionFlags || {};
    const risky = transactions.filter((tx) => (flagsByHash[tx.hash] || []).length > 0).length;
    const incoming = transactions.filter((tx) => tx.direction === "in").length;
    const outgoing = transactions.filter((tx) => tx.direction === "out").length;
    const token = transactions.filter((tx) => ["ERC20", "TRC20"].includes(tx.tokenType || "")).length;
    const spam = transactions.filter((tx) => tx.isSpamToken).length;

    return { incoming, outgoing, risky, spam, token, total: transactions.length };
  }, [analysis, transactions]);

  const loadTransactions = async (nextPage = 1, nextFingerprint = "") => {
    if (!address) {
      return;
    }

    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError("");

    try {
      const result = await listV2Transactions({
        address,
        networkKey: networkFilter,
        page: nextPage,
        limit: 25,
        cursor: nextFingerprint,
        includeDust,
      });
      const nextItems = result.items || [];

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setTransactions((current) => (nextPage === 1 && !nextFingerprint ? nextItems : [...current, ...nextItems]));
      setHasMore(Boolean(result.hasMore));
      setFingerprint(result.fingerprint || "");
      setPage(nextPage);
      setProviderMessage(result.message || "");
      setProviderErrors(result.errors || []);
      setScannedNetworks(result.scannedNetworks || []);
      setSkippedNetworks(result.skippedNetworks || []);
      setDustInfo({
        count: result.dustFilteredCount || 0,
        minAmount: result.dustMinAmount || "1 TRX",
      });
      setCacheInfo({
        hit: Boolean(result.cacheHit),
        fallback: Boolean(result.cacheFallback),
        saved: result.cacheSaved || 0,
        provider: result.cacheProvider || "",
      });
      setDataQuality(result.dataQuality || null);
      setAnalysis(result.analysis || null);
    } catch (loadError) {
      if (requestId === loadRequestIdRef.current) {
        setError(loadError.message);
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!address) {
      return undefined;
    }

    const timer = window.setTimeout(() => loadTransactions(1, ""), 80);
    return () => window.clearTimeout(timer);
  }, [address, networkFilter, includeDust]);

  const loadMore = () => {
    if (networkFilter === "TRX" || networkFilter === "BTC") {
      loadTransactions(page, fingerprint);
      return;
    }

    loadTransactions(page + 1, "");
  };

  return (
    <section className="panel p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-black p-3">
        <button
          className="ghost-button min-h-9 shrink-0 px-3"
          onClick={() => window.history.back()}
          title="Вернуться к предыдущему кошельку"
          type="button"
        >
          ← Назад
        </button>
        <div className="min-w-[240px] flex-1">
          <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-600">Сейчас открыты транзакции кошелька</p>
          <p className="mt-1 break-all font-mono text-sm text-zinc-200">{address}</p>
        </div>
        <p className="w-full border-t border-zinc-900 pt-2 text-xs text-zinc-500">Нажмите на адрес «Откуда» или «Куда», чтобы продолжить цепочку</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Transactions</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">История транзакций</h2>
        </div>
        <button className={`primary-button min-h-10 ${loading ? "button-loading" : ""}`} disabled={loading} onClick={() => loadTransactions(1, "")} type="button">
          {loading ? <LoadingDots label="Загрузка" /> : "Загрузить"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 overflow-x-auto pb-1">
        <NetworkFilterButtons
          availableNetworks={availableNetworks}
          networkFilter={networkFilter}
          setNetworkFilter={setNetworkFilter}
        />
        {networkFilter === "TRX" ? (
          <button
            className={`min-h-9 whitespace-nowrap rounded-md border px-3 text-xs ${
              includeDust
                ? "border-sentinel-warning/70 bg-sentinel-warning/10 text-sentinel-warning"
                : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setIncludeDust((current) => !current)}
            type="button"
          >
            {includeDust ? "Dust показан" : "Показать dust"}
          </button>
        ) : null}
      </div>

      {networkFilter === "TRX" && !includeDust && dustInfo.count ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
          Скрыто dust-транзакций: {dustInfo.count}. Порог: меньше {dustInfo.minAmount}.
        </div>
      ) : null}

      {dataQuality ? (
        <div className={`mt-4 rounded-lg border p-3 text-xs leading-5 ${
          dataQuality.dataMode === "live" && dataQuality.completeness !== "partial"
            ? "border-sentinel-green/35 bg-sentinel-green/5 text-zinc-400"
            : "border-sentinel-warning/40 bg-sentinel-warning/10 text-sentinel-warning"
        }`}>
          <p className="font-semibold text-zinc-200">
            Режим данных: {dataQuality.dataMode === "live" ? "реальные данные API" : dataQuality.dataMode === "cached" ? "сохранённый кэш" : "источник недоступен"}
          </p>
          <p className="mt-1">
            Источник: {dataQuality.sourceProvider || "не указан"} · полнота: {
              dataQuality.completeness === "paginated"
                ? "показана страница, доступны следующие"
                : dataQuality.completeness === "partial"
                  ? "частичная история"
                  : dataQuality.completeness === "unavailable"
                    ? "данные не получены"
                    : "текущее доступное окно"
            }
          </p>
          {dataQuality.warnings?.length ? <p className="mt-1">Ограничения: {dataQuality.warnings.join(" ")}</p> : null}
        </div>
      ) : null}

      {providerMessage ? (
        <div className="mt-4 rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/10 p-3 text-sm leading-6 text-sentinel-warning">
          {providerMessage}
        </div>
      ) : null}
      {scannedNetworks.length ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
          Проверены сети: {scannedNetworks.join(", ")}
        </div>
      ) : null}
      {skippedNetworks.length ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
          Не удалось проверить сети или нет бесплатного источника: {skippedNetworks.join(", ")}
        </div>
      ) : null}
      {providerErrors.length ? (
        <div className="mt-4 rounded-lg border border-sentinel-warning/40 bg-sentinel-warning/10 p-3 text-xs leading-5 text-sentinel-warning">
          Ограничения источников: {providerErrors.slice(0, 3).join(" | ")}
        </div>
      ) : null}
      {dataQuality?.networkChecks?.length ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
          <p className="font-semibold text-zinc-300">Результат проверки по сетям</p>
          <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {dataQuality.networkChecks.map((check) => (
              <p key={check.networkKey} title={check.note || ""}>
                <span className={
                  check.status === "checked"
                    ? "text-sentinel-green"
                    : check.status === "partial"
                      ? "text-sentinel-warning"
                      : "text-zinc-600"
                }>
                  {check.status === "checked" ? "✓" : check.status === "partial" ? "◐" : "—"}
                </span>{" "}
                {check.networkName}: {
                  Number.isFinite(check.transactionCount)
                    ? `${check.transactionCount} операций`
                    : "не проверено"
                }
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {cacheInfo?.hit || cacheInfo?.saved || cacheInfo?.fallback ? (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
          PostgreSQL cache: {cacheInfo.fallback ? "fallback" : cacheInfo.hit ? "hit" : "updated"}
          {cacheInfo.saved ? ` · saved ${cacheInfo.saved} tx` : ""}
          {cacheInfo.provider ? ` · ${cacheInfo.provider}` : ""}
        </div>
      ) : null}
      {error ? (
        <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm leading-6 text-sentinel-danger">
          {error}
        </div>
      ) : null}

      <RiskAnalysisPanel analysis={analysis} />

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Поиск транзакций"
            className="min-h-10 min-w-[220px] flex-1 rounded-md border border-zinc-800 bg-ink-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-zinc-600"
            onChange={(event) => setTxSearch(event.target.value)}
            placeholder="Поиск hash / from / to"
            type="search"
            value={txSearch}
          />
          {[
            ["all", "Все"],
            ["in", "Входящие"],
            ["out", "Исходящие"],
          ].map(([value, label]) => (
            <button
              className={`min-h-10 rounded-md border px-3 text-xs ${
                directionFilter === value
                  ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 bg-ink-950 text-zinc-500 hover:text-zinc-300"
              }`}
              key={value}
              onClick={() => setDirectionFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
          <button
            className={`min-h-10 rounded-md border px-3 text-xs ${
              riskOnly
                ? "border-sentinel-warning/70 bg-sentinel-warning/10 text-sentinel-warning"
                : "border-zinc-800 bg-ink-950 text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setRiskOnly((current) => !current)}
            type="button"
          >
            Risky only
          </button>
          <button
            className={`min-h-10 rounded-md border px-3 text-xs ${
              stablecoinOnly
                ? "border-sentinel-green/70 bg-sentinel-green/10 text-sentinel-green"
                : "border-zinc-800 bg-ink-950 text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setStablecoinOnly((current) => !current)}
            type="button"
          >
            Stablecoins only
          </button>
          <button
            className={`min-h-10 rounded-md border px-3 text-xs ${
              hideSpamTokens
                ? "border-sentinel-green/70 bg-sentinel-green/10 text-sentinel-green"
                : "border-sentinel-warning/70 bg-sentinel-warning/10 text-sentinel-warning"
            }`}
            onClick={() => setHideSpamTokens((current) => !current)}
            type="button"
          >
            {hideSpamTokens ? "Spam hidden" : "Spam shown"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-600">
          <span>Всего: {tableStats.total}</span>
          <span>Входящие: {tableStats.incoming}</span>
          <span>Исходящие: {tableStats.outgoing}</span>
          <span>Token tx: {tableStats.token}</span>
          <span>Spam-token: {tableStats.spam}</span>
          <span>Risk flags: {tableStats.risky}</span>
          <span>Показано: {filteredTransactions.length}</span>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500">
              <th className="py-3 pr-3 font-medium">Hash</th>
              <th className="py-3 pr-3 font-medium">Network</th>
              <th className="py-3 pr-3 font-medium">Direction</th>
              <th className="py-3 pr-3 font-medium">From</th>
              <th className="py-3 pr-3 font-medium">To</th>
              <th className="py-3 pr-3 font-medium">Value</th>
              <th className="py-3 pr-3 font-medium">Type</th>
              <th className="py-3 pr-3 font-medium">Time</th>
              <th className="py-3 pr-3 font-medium">Status</th>
              <th className="py-3 pr-3 font-medium">Risk</th>
            </tr>
          </thead>
          <tbody>
            {loading && !filteredTransactions.length ? (
              Array.from({ length: 6 }, (_, index) => (
                <tr className="border-b border-zinc-900" key={`tx-skeleton-${index}`}>
                  {Array.from({ length: 10 }, (_, cellIndex) => (
                    <td aria-label="Загрузка транзакции" className="py-3 pr-3" key={cellIndex}>
                      <div className="skeleton-line h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : null}
            {filteredTransactions.map((tx) => (
              <tr className="soft-enter border-b border-zinc-900 last:border-b-0" key={`${tx.networkKey}-${tx.hash}`}>
                <td className="py-3 pr-3">
                  <button className="block font-semibold text-zinc-200 hover:text-sentinel-green" onClick={() => setSelectedTransaction(tx)} title="Показать доказательные данные" type="button">{tx.txHash.slice(0, 12)}...</button>
                  {tx.explorerUrl ? <a className="mt-1 block text-[11px] text-zinc-600 hover:text-zinc-300" href={tx.explorerUrl} rel="noreferrer" target="_blank">открыть explorer ↗</a> : null}
                </td>
                <td className="py-3 pr-3 text-zinc-500">{tx.networkName}</td>
                <td className={tx.direction === "out" ? "py-3 pr-3 text-sentinel-danger" : "py-3 pr-3 text-sentinel-green"}>
                  {tx.direction}
                </td>
                <td className="py-3 pr-3">
                  <TransactionAddressButton address={tx.from} currentAddress={address} onOpenAddress={onOpenAddress} />
                </td>
                <td className="py-3 pr-3">
                  <TransactionAddressButton address={tx.to} currentAddress={address} onOpenAddress={onOpenAddress} />
                </td>
                <td className="py-3 pr-3 text-zinc-300">
                  <span className="block">{tx.value}</span>
                  {tx.usdValue ? (
                    <span className="block text-xs text-zinc-600">${tx.usdValue.toLocaleString("en-US")}</span>
                  ) : null}
                </td>
                <td className="py-3 pr-3 text-zinc-500">{tx.tokenType || "native"}</td>
                <td className="py-3 pr-3 text-zinc-500">
                  {tx.timestamp ? new Date(tx.timestamp).toLocaleString("ru-RU") : ""}
                </td>
                <td className="py-3 pr-3 text-zinc-500">{tx.status}</td>
                <td className="py-3 pr-3">
                  <div className="grid gap-1">
                    {tx.isSpamToken ? (
                      <span className="w-fit rounded border border-sentinel-warning/40 bg-sentinel-warning/10 px-2 py-1 text-[11px] text-sentinel-warning">
                        spam-token
                      </span>
                    ) : null}
                    <TransactionRiskTags flags={analysis?.transactionFlags?.[tx.hash] || []} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !transactions.length && !providerMessage ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
            Нажмите «Загрузить», чтобы получить историю транзакций.
          </div>
        ) : transactions.length && !filteredTransactions.length ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
            По текущим фильтрам транзакций нет.
          </div>
        ) : null}
      </div>

      <TransactionEvidenceCard transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />

      {hasMore ? (
        <button className={`ghost-button mt-4 min-h-10 w-full ${loading ? "button-loading" : ""}`} disabled={loading} onClick={loadMore} type="button">
          {loading ? <LoadingDots label="Загружаю" /> : "Загрузить еще"}
        </button>
      ) : null}
    </section>
  );
}

function RiskAnalysisPanel({ analysis }) {
  if (!analysis) {
    return null;
  }

  const signals = (analysis.signals || []).slice(0, 3);
  const factors = (analysis.riskFactors || []).slice(0, 3);
  const summary = analysis.summary || {};

  return (
    <section className="mt-4 border-y border-zinc-800 py-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-label">Risk analysis</p>
          <div className="mt-2 flex items-end gap-3">
            <p className="text-5xl font-semibold text-zinc-100">{analysis.riskScore ?? 0}</p>
            <p className="pb-2 text-xs text-zinc-500">по загруженной истории</p>
          </div>
        </div>
        <div className="flex max-w-4xl flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-500">
          <span>Tx: <span className="text-zinc-200">{summary.analyzedTransactions || 0}</span></span>
          <span>Spam excluded: <span className="text-zinc-200">{summary.spamTokenExcludedCount || 0}</span></span>
          <span>Mixer confidence: <span className="text-zinc-200">{summary.mixerHeuristicConfidence || 0}%</span></span>
          <span>Risk flags: <span className="text-zinc-200">{(summary.fastTransferCount || 0) + (summary.splitTransactionCount || 0) + (summary.exitCandidateCount || 0)}</span></span>
          <span>Services: <span className="text-zinc-200">{(summary.mixerHitCount || 0) + (summary.bridgeHitCount || 0) + (summary.exchangeHitCount || 0)}</span></span>
          <span>Stablecoin tx: <span className="text-zinc-200">{summary.stablecoinTransferCount || 0}</span></span>
        </div>
      </div>

      {factors.length ? (
        <div className="mt-4 divide-y divide-zinc-900 border-t border-zinc-900">
          {factors.map((factor) => (
            <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,220px)_80px_minmax(0,1fr)_120px]" key={`${factor.type}-${factor.txHashes?.[0] || factor.title}`}>
              <p className="text-sm font-semibold text-zinc-200">
                {factor.title}
                {factor.count > 1 ? <span className="ml-2 text-xs font-normal text-zinc-500">{factor.count} tx</span> : null}
              </p>
              <span className="text-xs font-semibold text-sentinel-warning">{factor.points} pts</span>
              <p className="text-xs leading-5 text-zinc-500">{factor.description}</p>
              <p className="text-xs text-zinc-600">confidence {factor.confidence}%</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 border-t border-zinc-900 pt-3 text-sm text-zinc-500">
          По загруженному диапазону явных риск-паттернов не найдено.
        </p>
      )}

      {signals.length ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {signals.map((signal) => (
            <span className={signal.severity === "high" ? "text-sentinel-danger" : "text-sentinel-warning"} key={signal.type}>
              {signal.title} · {signal.confidence}%
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TransactionRiskTags({ flags }) {
  if (!flags.length) {
    return <span className="text-xs text-zinc-700">clear</span>;
  }

  const labels = {
    exit_candidate: "exit",
    fast_in: "fast-in",
    fast_out: "fast-out",
    split: "split",
    fan_in: "fan-in",
    fan_out: "fan-out",
    round_amount: "round",
    mixer_contact: "mixer",
    bridge_hop: "bridge-hop",
    bridge_chain: "bridge-chain",
    bridge_to_exchange: "bridge->cex",
    exchange_cashout: "cash-out",
    exchange_deposit: "cex deposit",
    exchange_deanonymization: "deanon",
    exchange_funding_source: "cex source",
    bridge_contact: "bridge",
    exchange_contact: "exchange",
    mixer_chain: "mixer-chain",
    mixer_source: "mixer source",
    mixer_to_exchange: "mixer->cex",
    mixer_equalized_withdrawal: "equalized",
    mixer_denomination_cluster: "denom cluster",
    mixer_fresh_wallet_fanout: "fresh fanout",
    mixer_pool_behavior: "pool behavior",
    possible_mixer_flow: "mixer-flow",
    structured_denomination_cluster: "denom cluster",
    fresh_wallet_fanout: "fresh fanout",
    equalized_withdrawal_cluster: "equalized",
    pool_like_flow: "pool flow",
    stablecoin_fast_in: "stable-in",
    stablecoin_fast_out: "stable-out",
    known_mixer: "known mixer",
    known_bridge: "bridge",
    known_exchange: "exchange",
    known_scam: "scam",
    known_sanctions: "sanctions",
    known_service: "service",
  };

  return (
    <div className="flex max-w-40 flex-wrap gap-1">
      {flags.map((flag) => (
        <span className="rounded border border-sentinel-warning/40 bg-sentinel-warning/10 px-2 py-1 text-[11px] text-sentinel-warning" key={flag}>
          {labels[flag] || flag}
        </span>
      ))}
    </div>
  );
}


function ProviderCoveragePanel({ profile, rpcError }) {
  const isTron = profile.networkKey === "TRX";
  const isBitcoin = profile.networkKey === "BTC";
  const title = isTron ? "TRON data providers" : isBitcoin ? "Bitcoin data providers" : "EVM data providers";
  const description = isTron
    ? "TRON-профиль строится через публичный TRON API без пользовательского ключа: баланс, история транзакций и граф для risk score."
    : isBitcoin
      ? "Bitcoin-профиль использует Mempool.space, Blockstream Esplora и Blockchain.com для live-баланса, истории UTXO-транзакций, графа и risk score."
      : "EVM-профиль использует публичные JSON-RPC узлы для live-баланса, бесплатные Blockscout/Routescan источники для доступной истории и локальные labels/cases для risk score.";
  const coverage = isTron
    ? "TRON public API, graph, risk scoring"
    : isBitcoin
      ? "Mempool.space, Blockstream, Blockchain.com, PostgreSQL cache"
      : "Public EVM JSON-RPC, Blockscout/Routescan history, local attribution";

  return (
    <section className="panel p-4">
      <p className="section-label">Provider coverage</p>
      <h2 className="mt-1 text-lg font-semibold text-zinc-100">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-500">
        {description}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="panel-subtle p-3">
          <p className="text-xs text-zinc-500">Источник</p>
          <p className="mt-1 text-sm font-semibold text-zinc-100">{profile.source || "Provider not loaded"}</p>
        </div>
        <div className="panel-subtle p-3">
          <p className="text-xs text-zinc-500">Покрытие</p>
          <p className="mt-1 text-sm font-semibold text-zinc-100">{coverage}</p>
        </div>
      </div>
      {rpcError ? (
        <p className="mt-3 rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-xs leading-5 text-sentinel-danger">
          {rpcError}
        </p>
      ) : null}
    </section>
  );
}

function providerReportStatus(item) {
  if (item.loading) {
    return "loading";
  }
  if (item.error || item.warnings?.length) {
    return item.error ? "error" : "warning";
  }
  if (item.provider || item.ok) {
    return "ok";
  }
  return "idle";
}

function providerReportTone(status) {
  if (status === "ok") {
    return "border-sentinel-green/40 text-sentinel-green";
  }
  if (status === "warning") {
    return "border-sentinel-warning/40 text-sentinel-warning";
  }
  if (status === "error") {
    return "border-sentinel-danger/40 text-sentinel-danger";
  }
  return "border-zinc-700 text-zinc-500";
}

function WalletProviderReport({
  address,
  nftData,
  nftError,
  nftLoading,
  profile,
  rpcError,
  riskAnalysis,
  riskError,
  riskLoading,
  tokenData,
  tokenError,
  tokenLoading,
}) {
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address || "");
  const rows = [
    {
      label: "Live profile",
      provider: profile.source || "",
      ok: Boolean(profile.source || profile.liveData || profile.balance),
      details: profile.networkCandidates?.length ? `${profile.networkCandidates.length} networks checked` : `${profile.name} snapshot`,
      warnings: rpcError ? [rpcError] : [],
    },
    {
      label: "Risk score",
      provider: riskAnalysis?.provider || "Risk engine",
      loading: riskLoading,
      ok: Boolean(riskAnalysis),
      error: riskError,
      details: riskAnalysis ? `${riskAnalysis.riskScore} · ${riskAnalysis.riskLevel} · confidence ${riskAnalysis.confidence}%` : "waiting for risk API",
      warnings: riskAnalysis?.errors || [],
    },
    {
      label: "Transactions",
      provider: isEvm ? "Etherscan + Alchemy + Blockscout/Routescan" : profile.networkKey === "BTC" ? "Mempool + Blockstream + Blockchain.com" : "TronGrid",
      ok: true,
      details: "open Transactions tab for live fallback report",
      warnings: [],
    },
  ];

  if (isEvm) {
    rows.push(
      {
        label: "Token balances",
        provider: tokenData?.provider || "Alchemy Token API",
        loading: tokenLoading,
        ok: Boolean(tokenData),
        error: tokenError,
        details: tokenData ? `${tokenData.nonZeroTokenCount ?? 0} non-zero · ${tokenData.checkedNetworks?.length ?? 1} networks` : "waiting for token API",
        warnings: [...(tokenData?.warnings || []), ...(tokenData?.errors || [])],
      },
      {
        label: "NFT exposure",
        provider: nftData?.provider || "Alchemy NFT API",
        loading: nftLoading,
        ok: Boolean(nftData),
        error: nftError,
        details: nftData ? `${nftData.totalNftCount ?? 0} total · ${nftData.checkedNetworks?.length ?? 1} networks` : "waiting for NFT API",
        warnings: [...(nftData?.warnings || []), ...(nftData?.errors || [])],
      }
    );
  }

  return (
    <section className="panel p-4">
      <p className="section-label">Provider report</p>
      <h2 className="mt-1 text-lg font-semibold text-zinc-100">По этому адресу</h2>
      <div className="mt-4 grid gap-2">
        {rows.map((item) => {
          const status = providerReportStatus(item);
          const warnings = item.warnings?.filter(Boolean) || [];

          return (
            <article className="rounded-md border border-zinc-800 bg-black p-3" key={item.label}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-100">{item.label}</p>
                  <p className="mt-1 text-xs text-zinc-500">{item.provider || "provider unknown"}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] ${providerReportTone(status)}`}>
                  {status}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-zinc-500">{item.details}</p>
              {item.error ? (
                <p className="mt-2 rounded border border-sentinel-danger/40 bg-sentinel-danger/10 p-2 text-xs leading-5 text-sentinel-danger">
                  {item.error}
                </p>
              ) : null}
              {warnings.length ? (
                <details className="mt-2 text-xs text-sentinel-warning">
                  <summary className="cursor-pointer">warnings: {warnings.length}</summary>
                  <p className="mt-2 leading-5">{warnings.slice(0, 6).join(" | ")}</p>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}


function ArkhamIntelligencePanel({ address, error: externalError = "", intelligence: externalIntelligence, loading = false }) {
  const [status, setStatus] = useState("idle");
  const [intelligence, setIntelligence] = useState(null);
  const [error, setError] = useState("");
  const hasExternalIntelligence = externalIntelligence !== undefined || loading || externalError;

  useEffect(() => {
    let active = true;

    if (hasExternalIntelligence) {
      return undefined;
    }

    if (!address) {
      setStatus("idle");
      setIntelligence(null);
      setError("");
      return undefined;
    }

    setStatus("loading");
    setIntelligence(null);
    setError("");

    getArkhamAddressIntelligence(address)
      .then((result) => {
        if (!active) return;
        setIntelligence(result);
        setStatus(result.providerRequired ? "missing-key" : "success");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError.message);
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [address, hasExternalIntelligence]);

  const currentIntelligence = hasExternalIntelligence ? externalIntelligence : intelligence;
  const currentError = hasExternalIntelligence ? externalError : error;
  const currentStatus = hasExternalIntelligence
    ? loading
      ? "loading"
      : currentError
        ? "error"
        : currentIntelligence?.providerRequired
          ? "missing-key"
          : currentIntelligence
            ? "success"
            : "idle"
    : status;
  const entities = currentIntelligence?.entities || [];
  const labels = currentIntelligence?.labels || [];
  const tags = currentIntelligence?.tags || [];

  return (
    <div className="mt-5 rounded-lg border border-zinc-800 bg-black p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="section-label">Arkham intelligence</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Entity enrichment</h2>
        </div>
        <span className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-500">
          {currentStatus === "loading" ? <LoadingDots label="loading" /> : currentStatus === "success" ? "loaded" : currentStatus === "error" ? "error" : "idle"}
        </span>
      </div>

      <p className="mt-2 text-sm leading-6 text-zinc-500">
        Arkham добавит attribution по адресу: entity, labels, tags и chain coverage.
      </p>

      {currentStatus === "missing-key" ? (
        <p className="mt-3 rounded-md border border-zinc-700 bg-black p-3 text-xs leading-5 text-zinc-400">
          {currentIntelligence.message}
        </p>
      ) : null}

      {currentError ? (
        <p className="mt-3 rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-xs leading-5 text-sentinel-danger">
          {currentError}
        </p>
      ) : null}

      {currentStatus === "loading" ? (
        <div className="mt-4 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div className="panel-subtle p-3" key={item}>
                <SkeletonBlock lines={2} />
              </div>
            ))}
          </div>
          <div className="rounded-md border border-zinc-800 bg-ink-950 p-3">
            <SkeletonBlock lines={3} />
          </div>
        </div>
      ) : currentStatus === "success" ? (
        <div className="soft-enter mt-4 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <ArkhamCount label="Entities" value={entities.length} />
            <ArkhamCount label="Labels" value={labels.length} />
            <ArkhamCount label="Tags" value={tags.length} />
          </div>

          {entities.length ? (
            <ArkhamList title="Entities" items={entities.map((item) => item.type ? `${item.name} · ${item.type}` : item.name)} />
          ) : null}

          {labels.length ? (
            <ArkhamList title="Labels" items={labels.map((item) => item.type ? `${item.name} · ${item.type}` : item.name)} />
          ) : null}

          {tags.length ? (
            <ArkhamList title="Tags" items={tags.map((item) => item.type ? `${item.name} · ${item.type}` : item.name)} />
          ) : null}

          {!entities.length && !labels.length && !tags.length ? (
            <p className="rounded-md border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-500">
              Arkham ответил, но enrichment для этого адреса не найден.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ArkhamCount({ label, value }) {
  return (
    <div className="panel-subtle p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function ArkhamList({ title, items }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">{title}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.slice(0, 8).map((item) => (
          <span className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-300" key={item}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}


function MetricGrid({ profile, compact = false }) {
  const metrics = [
    ["Tx count", profile.tx, profile.source ? `source: ${profile.source}` : "live profile not loaded"],
    ["Подозрительные маршруты", profile.routes, "после risk/API анализа"],
    ["Кандидаты exit-address", profile.exits, "после mixer/API анализа"],
    ["Watchlist", profile.watchlistCount || 0, "сохраненные правила"],
  ];

  return (
    <section className={compact ? "grid gap-3" : "mt-4 grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[560px]:grid-cols-1"}>
      {metrics.map(([label, value, caption]) => (
        <article className="panel p-4" key={label}>
          <p className="text-xs text-zinc-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold text-zinc-100">{value}</p>
          <p className="mt-2 text-xs text-zinc-500">{caption}</p>
        </article>
      ))}
    </section>
  );
}

function shortAddress(value) {
  if (!value) {
    return "unknown";
  }

  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function graphEdgeCategoryColor(category) {
  const colors = {
    mixer: "#f25555",
    exchange: "#d8a84e",
    bridge: "#5aa7ff",
    service: "#b983ff",
    stablecoin: "#2fd16b",
    native: "#9aa4b2",
    unknown: "#6f7682",
  };

  return colors[category] || colors.unknown;
}

function uniqueValuesClient(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function uniqueNetworkCandidates(candidates = []) {
  const byNetwork = new Map();

  for (const candidate of candidates) {
    const key = candidate.networkKey || candidate.networkName || "UNKNOWN";
    const current = byNetwork.get(key);

    if (!current || Number(candidate.txCount || 0) > Number(current.txCount || 0)) {
      byNetwork.set(key, candidate);
    }
  }

  return [...byNetwork.values()];
}

function networkIconMeta(networkKey = "") {
  const key = String(networkKey || "UNKNOWN").toUpperCase();
  const meta = {
    BTC: ["B", "bitcoin", "bg-orange-500/15 text-orange-300 border-orange-500/30"],
    ETH: ["E", "ethereum", "bg-blue-500/15 text-blue-300 border-blue-500/30"],
    TRX: ["T", "cryptocurrency:trx", "bg-red-500/15 text-red-300 border-red-500/30"],
    SOL: ["S", "solana", "bg-violet-500/15 text-violet-300 border-violet-500/30"],
    STARKNET: ["S", "token-branded:starknet", "bg-purple-500/15 text-purple-300 border-purple-500/30"],
    BNB: ["B", "bnbchain", "bg-yellow-500/15 text-yellow-300 border-yellow-500/30"],
    POLYGON: ["P", "polygon", "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30"],
    AVAX: ["A", "cryptocurrency:avax", "bg-red-500/15 text-red-300 border-red-500/30"],
    ARB: ["A", "token-branded:arbitrum-one", "bg-sky-500/15 text-sky-300 border-sky-500/30"],
    BASE: ["B", "", "bg-blue-600 text-white border-blue-400/70 shadow-[inset_0_0_0_5px_#ffffff]"],
    BLAST: ["B", "token:blast", "bg-lime-300 text-black border-lime-100"],
    CELO: ["C", "token-branded:celo", "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"],
    HEMI: ["H", "token-branded:hemi", "bg-zinc-800 text-zinc-300 border-zinc-700"],
    HYPEREVM: ["H", "hyper", "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"],
    LINEA: ["L", "token-branded:linea", "bg-white text-black border-zinc-300"],
    SCROLL: ["S", "token-branded:scroll", "bg-orange-500/15 text-orange-300 border-orange-500/30"],
    MANTLE: ["M", "token-branded:mantle", "bg-cyan-500/15 text-cyan-300 border-cyan-500/30"],
    MEGAETH: ["M", "", "bg-zinc-800 text-zinc-300 border-zinc-700"],
    MONAD: ["M", "token-branded:monad", "bg-violet-500/15 text-violet-300 border-violet-500/30"],
    OP: ["O", "optimism", "bg-red-500/15 text-red-300 border-red-500/30"],
    OPBNB: ["O", "bnbchain", "bg-yellow-500/15 text-yellow-300 border-yellow-500/30"],
    PALM: ["P", "token-branded:palm", "bg-green-500/15 text-green-300 border-green-500/30"],
    SEI: ["S", "token-branded:sei", "bg-red-500/15 text-red-300 border-red-500/30"],
    UNICHAIN: ["U", "token-branded:unichain", "bg-pink-500/15 text-pink-300 border-pink-500/30"],
    ZKSYNC: ["Z", "token-branded:zksync", "bg-slate-500/15 text-slate-300 border-slate-500/30"],
    GNOSIS: ["G", "token-branded:gnosis", "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"],
    UNKNOWN: ["?", "", "bg-zinc-800 text-zinc-300 border-zinc-700"],
  };

  return meta[key] || [key.slice(0, 2), "", "bg-zinc-800 text-zinc-300 border-zinc-700"];
}

function iconifyUrl(iconName) {
  if (!iconName) {
    return "";
  }

  const [collection, name] = iconName.includes(":") ? iconName.split(":", 2) : ["simple-icons", iconName];
  return `${iconifyProtocol}://${iconifyHost}/${collection}/${name}.svg?color=%23f4f4f5`;
}

function NetworkIcon({ networkKey }) {
  const [broken, setBroken] = useState(false);
  const [fallback, iconName, iconClass] = networkIconMeta(networkKey);
  const iconUrl = iconifyUrl(iconName);

  useEffect(() => {
    setBroken(false);
  }, [iconUrl]);

  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${iconClass}`} title={networkKey || "UNKNOWN"}>
      {iconUrl && !broken ? (
        <img
          alt=""
          className="h-4 w-4"
          loading="lazy"
          onError={() => setBroken(true)}
          src={iconUrl}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

function NetworkFilterButtons({ availableNetworks, buttonClass = "min-h-9", networkFilter, setNetworkFilter }) {
  return availableNetworks.map((network) => (
    <button
      className={`${buttonClass} whitespace-nowrap rounded-md border px-3 text-xs ${
        networkFilter === network.key
          ? "border-zinc-500 bg-zinc-800 text-zinc-100"
          : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-300"
      }`}
      key={network.key}
      onClick={() => setNetworkFilter(network.key)}
      type="button"
    >
      {network.name}
    </button>
  ));
}

function clampGraphPosition(value, min = -400, max = 400) {
  return Math.max(min, Math.min(max, value));
}

function stableHashUnit(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function layoutGraph(graph, rootAddress) {
  const sourceNodes = graph?.nodes || [];
  const sourceEdges = graph?.edges || [];
  const degrees = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  const rootLower = rootAddress.toLowerCase();
  const groups = new Map();

  for (const edge of sourceEdges) {
    degrees.set(edge.from, (degrees.get(edge.from) || 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) || 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) || 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
  }

  for (const node of sourceNodes) {
    const isRoot = node.address?.toLowerCase() === rootLower;
    const depth = isRoot ? 0 : Math.max(1, Number(node.depth || 0));
    groups.set(depth, [...(groups.get(depth) || []), node]);
  }

  const orderedGroups = new Map(
    [...groups.entries()].map(([depth, group]) => [
      depth,
      [...group].sort((a, b) => {
        const degreeDelta = (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0);

        if (degreeDelta) return degreeDelta;

        const flowDelta =
          (outgoing.get(b.id) || 0) - (incoming.get(b.id) || 0) -
          ((outgoing.get(a.id) || 0) - (incoming.get(a.id) || 0));

        if (flowDelta) return flowDelta;

        return stableHashUnit(a.id) - stableHashUnit(b.id);
      }),
    ])
  );

  const laidOutNodes = sourceNodes.map((node) => {
    const isRoot = node.address?.toLowerCase() === rootLower;
    const depth = isRoot ? 0 : Math.max(1, Number(node.depth || 0));
    const group = orderedGroups.get(depth) || [];
    const index = Math.max(0, group.findIndex((item) => item.id === node.id));
    const rowGap = depth === 0 ? 0 : Math.max(72, Math.min(108, 760 / Math.max(1, group.length - 1)));
    const yAnchor = depth === 0 ? 0 : (index - (group.length - 1) / 2) * rowGap;
    const degree = degrees.get(node.id) || 0;

    return {
      ...node,
      depth,
      label: isRoot ? "Target" : node.nametag || shortAddress(node.address),
      secondaryLabel: node.nametag ? shortAddress(node.address) : "",
      x: Number((depth * 340).toFixed(2)),
      y: Number(clampGraphPosition(yAnchor, -5000, 5000).toFixed(2)),
      degree,
      incoming: incoming.get(node.id) || 0,
      outgoing: outgoing.get(node.id) || 0,
      size: Math.min(46, 32 + Math.sqrt(degree) * 4),
      tone: isRoot
        ? "border-sentinel-green text-sentinel-green bg-sentinel-green/10"
        : depth >= 4
          ? "border-zinc-700 text-zinc-400"
          : "border-zinc-600 text-zinc-300",
    };
  });

  return {
    ...graph,
    nodes: laidOutNodes,
    edges: graph?.edges || [],
  };
}

function graphBounds(nodes = []) {
  if (!nodes.length) {
    return null;
  }

  const xs = nodes.map((node) => Number(node.x || 0));
  const ys = nodes.map((node) => Number(node.y || 0));

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function cubicPoint(start, controlA, controlB, end, t) {
  const oneMinusT = 1 - t;

  return {
    x:
      oneMinusT ** 3 * start.x +
      3 * oneMinusT ** 2 * t * controlA.x +
      3 * oneMinusT * t ** 2 * controlB.x +
      t ** 3 * end.x,
    y:
      oneMinusT ** 3 * start.y +
      3 * oneMinusT ** 2 * t * controlA.y +
      3 * oneMinusT * t ** 2 * controlB.y +
      t ** 3 * end.y,
  };
}

function graphEdgeGeometry(from, to, lane = 0) {
  const deltaX = Number(to.x || 0) - Number(from.x || 0);
  const deltaY = Number(to.y || 0) - Number(from.y || 0);
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const unitX = deltaX / distance;
  const unitY = deltaY / distance;
  const normalX = -unitY;
  const normalY = unitX;
  const laneOffset = lane * 24;
  const fromPadding = Math.max(28, Number(from.size || 36) / 2 + 14);
  const toPadding = Math.max(32, Number(to.size || 36) / 2 + 18);
  const start = {
    x: Number(from.x || 0) + unitX * fromPadding + normalX * laneOffset,
    y: Number(from.y || 0) + unitY * fromPadding + normalY * laneOffset,
  };
  const end = {
    x: Number(to.x || 0) - unitX * toPadding + normalX * laneOffset,
    y: Number(to.y || 0) - unitY * toPadding + normalY * laneOffset,
  };
  const curve = Math.max(72, Math.min(210, distance * 0.34));
  const controlA = {
    x: start.x + unitX * curve + normalX * laneOffset * 0.35,
    y: start.y + unitY * curve + normalY * laneOffset * 0.35,
  };
  const controlB = {
    x: end.x - unitX * curve + normalX * laneOffset * 0.35,
    y: end.y - unitY * curve + normalY * laneOffset * 0.35,
  };
  const label = cubicPoint(start, controlA, controlB, end, 0.5);

  return {
    end,
    label,
    path: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} C ${controlA.x.toFixed(2)} ${controlA.y.toFixed(2)}, ${controlB.x.toFixed(2)} ${controlB.y.toFixed(2)}, ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    start,
  };
}

function graphNodeKeyClient(networkKey, address) {
  return `${networkKey || "UNKNOWN"}:${String(address || "").toLowerCase()}`;
}

function graphTransactionKey(tx = {}) {
  return [
    tx.networkKey || "UNKNOWN",
    tx.txHash || tx.hash || "no-hash",
    tx.tokenContract || tx.tokenSymbol || tx.tokenType || "native",
    tx.from || "",
    tx.to || "",
    tx.rawValue || tx.value || "",
  ].join(":").toLowerCase();
}

function graphTransactionCategory(tx = {}) {
  const tokenSymbol = String(tx.tokenSymbol || "").toUpperCase();
  const tokenType = String(tx.tokenType || "native").toLowerCase();

  if (stablecoinTokenSymbols.has(tokenSymbol)) return "stablecoin";
  if (tokenType === "native") return "native";
  return "unknown";
}

function findGraphNodeIdByAddress(nodes = [], address, networkKey) {
  const lowerAddress = String(address || "").toLowerCase();
  const targetNetwork = String(networkKey || "UNKNOWN").toUpperCase();

  return nodes.find((node) => {
    const nodeNetwork = String(node.networkKey || "UNKNOWN").toUpperCase();

    return (
      String(node.address || "").toLowerCase() === lowerAddress &&
      (nodeNetwork === targetNetwork || nodeNetwork === "ALL" || targetNetwork === "ALL")
    );
  })?.id || "";
}

function buildManualGraphTransactionPatch(currentGraph, sourceNode, tx) {
  if (!currentGraph || !sourceNode || !tx?.from || !tx?.to) {
    return null;
  }

  const nodes = currentGraph.nodes || [];
  const txNetwork = tx.networkKey || sourceNode.networkKey || currentGraph.networkKey || "UNKNOWN";
  const sourceAddress = String(sourceNode.address || "").toLowerCase();
  const fromLower = String(tx.from || "").toLowerCase();
  const toLower = String(tx.to || "").toLowerCase();
  const fromIsSource = fromLower === sourceAddress;
  const toIsSource = toLower === sourceAddress;

  if (!fromIsSource && !toIsSource) {
    return null;
  }

  const fromId = fromIsSource
    ? sourceNode.id
    : findGraphNodeIdByAddress(nodes, tx.from, txNetwork) || graphNodeKeyClient(txNetwork, tx.from);
  const toId = toIsSource
    ? sourceNode.id
    : findGraphNodeIdByAddress(nodes, tx.to, txNetwork) || graphNodeKeyClient(txNetwork, tx.to);
  const transactionKey = graphTransactionKey(tx);
  const edgeId = `manual:${transactionKey}:${fromId}:${toId}`;
  const sourceDepth = Number(sourceNode.depth || 0);
  const fromDepth = fromIsSource ? sourceDepth : sourceDepth + 1;
  const toDepth = toIsSource ? sourceDepth : sourceDepth + 1;
  const fromNetworkKey = fromIsSource ? sourceNode.networkKey || txNetwork : txNetwork;
  const toNetworkKey = toIsSource ? sourceNode.networkKey || txNetwork : txNetwork;
  const fromNetworkName = fromIsSource ? sourceNode.networkName || fromNetworkKey : tx.networkName || txNetwork;
  const toNetworkName = toIsSource ? sourceNode.networkName || toNetworkKey : tx.networkName || txNetwork;
  const edgeCategory = graphTransactionCategory(tx);
  const txHash = tx.txHash || tx.hash || "";

  return {
    nodes: [
      {
        id: fromId,
        address: tx.from,
        networkKey: fromNetworkKey,
        networkName: fromNetworkName,
        depth: fromDepth,
        txCount: 0,
        parentIds: fromIsSource ? sourceNode.parentIds || [] : [sourceNode.id],
        manualAdded: true,
      },
      {
        id: toId,
        address: tx.to,
        networkKey: toNetworkKey,
        networkName: toNetworkName,
        depth: toDepth,
        txCount: 0,
        parentIds: toIsSource ? sourceNode.parentIds || [] : [sourceNode.id],
        manualAdded: true,
      },
    ],
    edge: {
      id: edgeId,
      transactionKey,
      hash: txHash,
      txHashes: txHash ? [txHash] : [],
      from: fromId,
      to: toId,
      fromAddress: tx.from,
      toAddress: tx.to,
      value: tx.value || `${tx.rawValue || ""} ${tx.tokenSymbol || txNetwork}`.trim(),
      rawValue: tx.rawValue || "",
      amount: tx.amount || null,
      usdPrice: tx.usdPrice ?? null,
      usdValue: tx.usdValue ?? null,
      priceProvider: tx.priceProvider || "",
      pricedAt: tx.pricedAt || "",
      tokenSymbol: tx.tokenSymbol || (tx.tokenType === "native" ? txNetwork : "TOKEN"),
      tokenType: tx.tokenType || "native",
      tokenDecimals: tx.tokenDecimals ?? null,
      investigationReasons: [
        {
          type: "manual_graph_selection",
          title: "Manual graph selection",
          description: "Added by analyst from the selected node transaction list.",
        },
      ],
      edgeCategory,
      timestamp: tx.timestamp,
      networkKey: txNetwork,
      networkName: tx.networkName || txNetwork,
      explorerUrl: tx.explorerUrl,
      provider: tx.provider || "",
      txCount: 1,
      manualAdded: true,
    },
  };
}

function mergeManualGraphTransaction(currentGraph, sourceNode, tx) {
  const patch = buildManualGraphTransactionPatch(currentGraph, sourceNode, tx);

  if (!patch) {
    return { graph: currentGraph, edgeId: "", nextNodeId: "", added: false };
  }

  const nodes = new Map((currentGraph.nodes || []).map((node) => [node.id, node]));
  const edges = new Map((currentGraph.edges || []).map((edge) => [edge.id, edge]));
  const nextNodeId = patch.edge.from === sourceNode.id ? patch.edge.to : patch.edge.from;

  if (edges.has(patch.edge.id)) {
    return { graph: currentGraph, edgeId: patch.edge.id, nextNodeId, added: false };
  }

  for (const patchNode of patch.nodes) {
    const existing = nodes.get(patchNode.id);

    nodes.set(patchNode.id, {
      ...patchNode,
      ...existing,
      ...patchNode,
      depth: existing ? Math.min(Number(existing.depth || patchNode.depth), Number(patchNode.depth || 0)) : patchNode.depth,
      txCount: (existing?.txCount || 0) + 1,
      parentIds: uniqueValuesClient([...(existing?.parentIds || []), ...(patchNode.parentIds || [])]),
    });
  }

  edges.set(patch.edge.id, patch.edge);

  const nextNodes = [...nodes.values()].sort((a, b) => Number(a.depth || 0) - Number(b.depth || 0));
  const nextEdges = [...edges.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return {
    graph: {
      ...currentGraph,
      nodes: nextNodes,
      edges: nextEdges,
      provider: currentGraph.provider || patch.edge.provider || "",
      providers: uniqueValuesClient([...(currentGraph.providers || []), patch.edge.provider].filter(Boolean)),
      scannedNetworks: uniqueValuesClient([...(currentGraph.scannedNetworks || []), patch.edge.networkName || patch.edge.networkKey]),
      stats: {
        ...currentGraph.stats,
        nodeCount: nextNodes.length,
        edgeCount: nextEdges.length,
        manualEdges: (currentGraph.stats?.manualEdges || 0) + 1,
        lazy: true,
      },
    },
    edgeId: patch.edge.id,
    nextNodeId,
    added: true,
  };
}

function createRootGraph(address, profile, networkKey, { depth, maxNodes, perAddressLimit }) {
  const rootId = graphNodeKeyClient(networkKey, address);

  return {
    address,
    networkKey,
    depth,
    maxNodes,
    perAddressLimit,
    nodes: [
      {
        id: rootId,
        address,
        networkKey,
        networkName: profile.name || networkKey,
        depth: 0,
        txCount: 0,
        lazyRoot: true,
        parentIds: [],
      },
    ],
    edges: [],
    stats: {
      scannedAddresses: 0,
      nodeCount: 1,
      edgeCount: 0,
      truncated: false,
      queuedRemainder: 0,
      arkhamEnrichedNodes: 0,
      lazy: true,
    },
    errors: [],
  };
}

function mergeGraphNeighbors(currentGraph, neighborGraph, expandedNode) {
  if (!currentGraph || !neighborGraph || !expandedNode) {
    return currentGraph;
  }

  const nodes = new Map((currentGraph.nodes || []).map((node) => [node.id, node]));
  const edges = new Map((currentGraph.edges || []).map((edge) => [edge.id, edge]));
  const parentDepth = Number(expandedNode.depth || 0);
  const idAliases = new Map();

  for (const incoming of neighborGraph.nodes || []) {
    const isExpandedNode = incoming.address?.toLowerCase() === expandedNode.address?.toLowerCase();
    const nodeId = isExpandedNode ? expandedNode.id : incoming.id;

    if (isExpandedNode && incoming.id !== expandedNode.id) {
      idAliases.set(incoming.id, expandedNode.id);
    }

    const adjustedDepth = isExpandedNode ? parentDepth : parentDepth + 1;
    const existing = nodes.get(nodeId);
    const parentIds = isExpandedNode
      ? existing?.parentIds || incoming.parentIds || []
      : [...new Set([...(existing?.parentIds || []), ...(incoming.parentIds || []), expandedNode.id].filter(Boolean))];

    nodes.set(nodeId, {
      ...incoming,
      ...existing,
      ...incoming,
      id: nodeId,
      networkKey: isExpandedNode ? expandedNode.networkKey : incoming.networkKey,
      networkName: isExpandedNode ? expandedNode.networkName : incoming.networkName,
      depth: existing ? Math.min(Number(existing.depth || adjustedDepth), adjustedDepth) : adjustedDepth,
      lazyRoot: existing?.lazyRoot,
      parentIds,
    });
  }

  for (const edge of neighborGraph.edges || []) {
    const from = idAliases.get(edge.from) || edge.from;
    const to = idAliases.get(edge.to) || edge.to;
    const id = `${edge.id}:${from}:${to}`;

    edges.set(id, {
      ...edge,
      id,
      from,
      to,
    });
  }

  const nextNodes = [...nodes.values()].sort((a, b) => Number(a.depth || 0) - Number(b.depth || 0));
  const nextEdges = [...edges.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return {
    ...currentGraph,
    nodes: nextNodes,
    edges: nextEdges,
    provider: neighborGraph.provider || currentGraph.provider || "",
    providers: [...new Set([...(currentGraph.providers || []), ...(neighborGraph.providers || [])])],
    scannedNetworks: [...new Set([...(currentGraph.scannedNetworks || []), ...(neighborGraph.scannedNetworks || [])])],
    providerErrors: [...new Set([...(currentGraph.providerErrors || []), ...(neighborGraph.providerErrors || [])])].slice(0, 12),
    stats: {
      ...currentGraph.stats,
      nodeCount: nextNodes.length,
      edgeCount: nextEdges.length,
      scannedAddresses: (currentGraph.stats?.scannedAddresses || 0) + (neighborGraph.stats?.scannedAddresses || 0),
      truncated: Boolean(currentGraph.stats?.truncated || neighborGraph.stats?.truncated),
      queuedRemainder: neighborGraph.stats?.queuedRemainder || currentGraph.stats?.queuedRemainder || 0,
      arkhamEnrichedNodes: nextNodes.filter((node) => node.nametag).length,
      lazy: true,
    },
    errors: [...new Set([...(currentGraph.errors || []), ...(neighborGraph.errors || [])])].slice(0, 12),
  };
}

function findShortestGraphPath(nodes, edges, startId, endId) {
  if (!startId || !endId || startId === endId) {
    return { nodeIds: startId ? [startId] : [], edgeIds: [] };
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      continue;
    }

    adjacency.get(edge.from).push({ nodeId: edge.to, edgeId: edge.id });
    adjacency.get(edge.to).push({ nodeId: edge.from, edgeId: edge.id });
  }

  const queue = [startId];
  const visited = new Set([startId]);
  const previous = new Map();

  while (queue.length) {
    const current = queue.shift();

    if (current === endId) {
      break;
    }

    for (const next of adjacency.get(current) || []) {
      if (visited.has(next.nodeId)) {
        continue;
      }

      visited.add(next.nodeId);
      previous.set(next.nodeId, { nodeId: current, edgeId: next.edgeId });
      queue.push(next.nodeId);
    }
  }

  if (!visited.has(endId)) {
    return { nodeIds: [], edgeIds: [] };
  }

  const nodeIdsPath = [endId];
  const edgeIdsPath = [];
  let current = endId;

  while (current !== startId) {
    const item = previous.get(current);

    if (!item) {
      break;
    }

    edgeIdsPath.unshift(item.edgeId);
    nodeIdsPath.unshift(item.nodeId);
    current = item.nodeId;
  }

  return { nodeIds: nodeIdsPath, edgeIds: edgeIdsPath };
}

function TransactionGraph(props) {
  const { address, profile, addFeed, openWalletProfile, restoredCase, activeWorkspaceId, saveWatchlistRule } = props;
  const canvasRef = useRef(null);
  const defaultGraphNetwork = defaultProfileNetwork(profile);
  const defaultPreset = graphModePresets[defaultGraphMode];
  const graphStoragePrefix = `chainsentinel:graph:${activeWorkspaceId || "default"}:${address || "empty"}`;
  const [networkFilter, setNetworkFilter] = useSessionState(`${graphStoragePrefix}:network`, defaultGraphNetwork);
  const [graphData, setGraphData] = useSessionState(`${graphStoragePrefix}:data`, null);
  const [graphMode, setGraphModeState] = useSessionState(`${graphStoragePrefix}:mode`, defaultGraphMode);
  const [depth, setDepth] = useSessionState(`${graphStoragePrefix}:depth`, defaultPreset.depth);
  const [maxNodes, setMaxNodes] = useSessionState(`${graphStoragePrefix}:max-nodes`, defaultPreset.maxNodes);
  const [perAddressLimit, setPerAddressLimit] = useSessionState(`${graphStoragePrefix}:per-address`, defaultPreset.perAddressLimit);
  const [graphStartAt, setGraphStartAt] = useSessionState(`${graphStoragePrefix}:start`, () => localDateTimeValue(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)));
  const [graphEndAt, setGraphEndAt] = useSessionState(`${graphStoragePrefix}:end`, () => localDateTimeValue(new Date()));
  const [graphFlowDirection, setGraphFlowDirection] = useSessionState(`${graphStoragePrefix}:flow`, "outgoing");
  const [positions, setPositions] = useSessionState(`${graphStoragePrefix}:positions`, {});
  const [hiddenNodeIds, setHiddenNodeIds] = useSessionState(`${graphStoragePrefix}:hidden`, []);
  const [expandedNodeIds, setExpandedNodeIds] = useSessionState(`${graphStoragePrefix}:expanded`, []);
  const [showAllGraphLayers, setShowAllGraphLayers] = useSessionState(`${graphStoragePrefix}:all-layers`, false);
  const [expandingNodeIds, setExpandingNodeIds] = useState([]);
  const [pinnedNodeIds, setPinnedNodeIds] = useSessionState(`${graphStoragePrefix}:pinned`, []);
  const [suspiciousNodeIds, setSuspiciousNodeIds] = useSessionState(`${graphStoragePrefix}:suspicious`, []);
  const [edgeAnnotations, setEdgeAnnotations] = useSessionState(`${graphStoragePrefix}:annotations`, {});
  const [graphFilters, setGraphFilters] = useSessionState(`${graphStoragePrefix}:filters`, defaultGraphFilters);
  const [viewport, setViewport] = useSessionState(`${graphStoragePrefix}:viewport`, { x: 120, y: 320, zoom: 1 });
  const [selectedNodeId, setSelectedNodeId] = useSessionState(`${graphStoragePrefix}:selected-node`, "");
  const [hoveredNodeId, setHoveredNodeId] = useState("");
  const [pathStartId, setPathStartId] = useSessionState(`${graphStoragePrefix}:path-start`, "");
  const [pathEndId, setPathEndId] = useSessionState(`${graphStoragePrefix}:path-end`, "");
  const [inspectorTab, setInspectorTab] = useSessionState(`${graphStoragePrefix}:inspector`, "profile");
  const [draggingNodeId, setDraggingNodeId] = useState("");
  const [panningFrom, setPanningFrom] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useSessionState(`${graphStoragePrefix}:selected-edge`, "");
  const [activeCaseId, setActiveCaseId] = useSessionState(`${graphStoragePrefix}:case`, "");
  const graphContextRef = useRef(`${address}|${profile.networkKey}`);

  const resetGraphState = ({ message: nextMessage = "", network = networkFilter, resetInspector = false } = {}) => {
    setNetworkFilter(network);
    setGraphData(null);
    setPositions({});
    setHiddenNodeIds([]);
    setExpandedNodeIds([]);
    setShowAllGraphLayers(false);
    setExpandingNodeIds([]);
    setPinnedNodeIds([]);
    setSuspiciousNodeIds([]);
    setEdgeAnnotations({});
    setGraphFilters(defaultGraphFilters);
    setGraphMode(defaultGraphMode);
    setViewport({ x: 120, y: 320, zoom: 1 });
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setActiveCaseId("");
    setPathStartId("");
    setPathEndId("");
    if (resetInspector) {
      setInspectorTab("transactions");
    }
    setMessage(nextMessage);
    setError("");
  };

  const setGraphMode = (mode) => {
    const preset = graphModePresets[mode] || graphModePresets[defaultGraphMode];

    setGraphModeState(mode);
    setDepth(preset.depth);
    setMaxNodes(preset.maxNodes);
    setPerAddressLimit(preset.perAddressLimit);
  };

  useEffect(() => {
    const nextContext = `${address}|${profile.networkKey}`;
    if (graphContextRef.current === nextContext) return;
    graphContextRef.current = nextContext;
    const nextGraphNetwork = defaultProfileNetwork(profile);
    resetGraphState({ network: nextGraphNetwork });
  }, [address, profile.networkKey]);

  useEffect(() => {
    if (!restoredCase?.graphState || restoredCase.rootAddress !== address) {
      return;
    }

    const state = restoredCase.graphState;
    const params = state.params || {};

    setNetworkFilter(params.networkFilter || restoredCase.networkKey || profile.networkKey);
    setGraphModeState(params.graphMode || "custom");
    setDepth(params.depth || 5);
    setMaxNodes(params.maxNodes || 120);
    setPerAddressLimit(params.perAddressLimit || 8);
    setGraphStartAt(params.startAt ? localDateTimeValue(new Date(params.startAt)) : localDateTimeValue(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)));
    setGraphEndAt(params.endAt ? localDateTimeValue(new Date(params.endAt)) : localDateTimeValue(new Date()));
    setGraphFlowDirection(params.flowDirection || "outgoing");
    setGraphData(state.graphData || null);
    setPositions(state.positions || {});
    setHiddenNodeIds(state.hiddenNodeIds || []);
    setExpandedNodeIds(state.expandedNodeIds || []);
    setShowAllGraphLayers(Boolean(state.showAllGraphLayers));
    setExpandingNodeIds([]);
    setPinnedNodeIds(state.pinnedNodeIds || []);
    setSuspiciousNodeIds(state.suspiciousNodeIds || []);
    setEdgeAnnotations(state.edgeAnnotations || {});
    setGraphFilters({ ...defaultGraphFilters, ...(state.graphFilters || {}), categories: { ...defaultGraphFilters.categories, ...(state.graphFilters?.categories || {}) } });
    setViewport(state.viewport || { x: 120, y: 320, zoom: 1 });
    setPathStartId(state.pathStartId || "");
    setPathEndId(state.pathEndId || "");
    setSelectedEdgeId(state.selectedEdgeId || "");
    setSelectedNodeId(state.selectedNodeId || state.pathStartId || state.graphData?.nodes?.[0]?.id || "");
    setInspectorTab(state.inspectorTab || "profile");
    setActiveCaseId(restoredCase.id || "");
    setMessage(`Восстановлен кейс: ${restoredCase.title}`);
    setError("");
  }, [address, profile.networkKey, restoredCase]);

  const availableNetworks = profileNetworkOptions(profile);
  const graph = useMemo(() => layoutGraph(graphData, address), [address, graphData]);
  const positionedGraph = useMemo(() => {
    const enrichedNodes = (graph.nodes || []).map((node) => ({
        ...node,
        pinned: pinnedNodeIds.includes(node.id),
        suspicious: suspiciousNodeIds.includes(node.id),
        ...positions[node.id],
      }));
    const sourceEdges = graph.edges || [];
    const enrichedNodeById = new Map(enrichedNodes.map((node) => [node.id, node]));
    const expandedNodeSet = new Set(expandedNodeIds);
    const levelVisibleNodeIds = new Set(
      (showAllGraphLayers ? enrichedNodes : enrichedNodes.filter((node) => Number(node.depth || 0) === 0)).map((node) => node.id)
    );

    for (const expandedNodeId of expandedNodeSet) {
      const expandedNode = enrichedNodeById.get(expandedNodeId);

      if (!expandedNode) {
        continue;
      }

      for (const edge of sourceEdges) {
        const childId = edge.from === expandedNodeId ? edge.to : edge.to === expandedNodeId ? edge.from : "";
        const childNode = childId ? enrichedNodeById.get(childId) : null;

        if (
          childNode &&
          (
            (childNode.parentIds || []).includes(expandedNodeId) ||
            Number(childNode.depth || 0) === Number(expandedNode.depth || 0) + 1
          )
        ) {
          levelVisibleNodeIds.add(childNode.id);
        }
      }

      for (const node of enrichedNodes) {
        if ((node.parentIds || []).includes(expandedNodeId)) {
          levelVisibleNodeIds.add(node.id);
        }
      }
    }

    const filteredNodes = enrichedNodes.filter((node) => {
      if (!levelVisibleNodeIds.has(node.id)) return false;
      if (hiddenNodeIds.includes(node.id)) return false;
      return true;
    });
    const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = sourceEdges
      .filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to))
      .filter((edge) => {
        const annotationStatus = edgeAnnotations[edge.id]?.status || "";
        const tokenSymbol = String(edge.tokenSymbol || "").toUpperCase();
        const tokenType = String(edge.tokenType || "native").toLowerCase();
        const isStablecoin = stablecoinTokenSymbols.has(tokenSymbol);
        const isNative = tokenType === "native";
        const edgeCategory = edge.edgeCategory || (isStablecoin ? "stablecoin" : isNative ? "native" : "unknown");
        const isRiskEdge =
          annotationStatus === "suspicious" ||
          annotationStatus === "mixer_flow" ||
          (edge.investigationReasons || []).some((reason) => !["native_value", "stablecoin"].includes(reason.type));
        const usdValue = Number(edge.usdValue);
        const minUsd = Number(graphFilters.minAmount);

        if (graphFilters.riskOnly && !isRiskEdge) return false;
        if (graphFilters.categories && graphFilters.categories[edgeCategory] === false) return false;
        if (!graphFilters.stablecoins && isStablecoin) return false;
        if (!graphFilters.native && isNative) return false;
        if (graphFilters.hideKnownServices && annotationStatus === "ignored") return false;
        if (Number.isFinite(minUsd) && minUsd > 0 && (!Number.isFinite(usdValue) || usdValue < minUsd)) return false;
        if (selectedNodeId && graphFilters.flowDirection === "in" && edge.to !== selectedNodeId) return false;
        if (selectedNodeId && graphFilters.flowDirection === "out" && edge.from !== selectedNodeId) return false;

        return true;
      });

    return {
      ...graph,
      nodes: filteredNodes,
      edges: filteredEdges,
    };
  }, [edgeAnnotations, expandedNodeIds, graph, graphFilters, hiddenNodeIds, pinnedNodeIds, positions, selectedNodeId, showAllGraphLayers, suspiciousNodeIds]);
  const nodeById = new Map((positionedGraph.nodes || []).map((node) => [node.id, node]));
  const fullNodeById = useMemo(() => new Map((graph.nodes || []).map((node) => [node.id, node])), [graph.nodes]);
  const expandableChildCounts = useMemo(() => {
    const counts = new Map();

    for (const edge of graph.edges || []) {
      const from = fullNodeById.get(edge.from);
      const to = fullNodeById.get(edge.to);

      if (!from || !to) {
        continue;
      }

      if (Number(to.depth || 0) === Number(from.depth || 0) + 1) {
        counts.set(from.id, (counts.get(from.id) || 0) + 1);
      }

      if (Number(from.depth || 0) === Number(to.depth || 0) + 1) {
        counts.set(to.id, (counts.get(to.id) || 0) + 1);
      }
    }

    return counts;
  }, [fullNodeById, graph.edges]);
  const expandedNodeSet = new Set(expandedNodeIds);
  const expandingNodeSet = new Set(expandingNodeIds);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? (positionedGraph.edges || []).find((edge) => edge.id === selectedEdgeId) : null;
  const edgeGeometryById = useMemo(() => {
    const nodes = new Map((positionedGraph.nodes || []).map((node) => [node.id, node]));
    const groupedEdges = new Map();
    const lanes = new Map();

    for (const edge of positionedGraph.edges || []) {
      const groupKey = [edge.from, edge.to].sort().join("<>");
      groupedEdges.set(groupKey, [...(groupedEdges.get(groupKey) || []), edge.id]);
    }

    for (const edgeIds of groupedEdges.values()) {
      edgeIds.forEach((edgeId, index) => {
        lanes.set(edgeId, index - (edgeIds.length - 1) / 2);
      });
    }

    return new Map(
      (positionedGraph.edges || [])
        .map((edge) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);

          if (!from || !to) {
            return null;
          }

          return [edge.id, graphEdgeGeometry(from, to, lanes.get(edge.id) || 0)];
        })
        .filter(Boolean)
    );
  }, [positionedGraph.edges, positionedGraph.nodes]);
  const selectedEdges = selectedNode
    ? (positionedGraph.edges || []).filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
    : [];
  const addedGraphTxIds = useMemo(() => new Set(
    (graphData?.edges || []).flatMap((edge) => [edge.transactionKey, edge.hash, ...(edge.txHashes || [])].filter(Boolean))
  ), [graphData?.edges]);
  const pathResult = useMemo(
    () => findShortestGraphPath(positionedGraph.nodes || [], positionedGraph.edges || [], pathStartId, pathEndId),
    [pathEndId, pathStartId, positionedGraph.edges, positionedGraph.nodes]
  );
  const highlightedNodeIds = new Set(pathResult.nodeIds || []);
  const highlightedEdgeIds = new Set(pathResult.edgeIds || []);
  const graphDepths = useMemo(() => {
    const depthValues = (positionedGraph.nodes || []).map((node) => Number(node.depth || 0));
    const maxDepth = Math.max(0, ...depthValues);

    return Array.from({ length: maxDepth + 1 }, (_, depthIndex) => ({
      depth: depthIndex,
      x: depthIndex * 340,
      count: depthValues.filter((depthValue) => depthValue === depthIndex).length,
    }));
  }, [positionedGraph.nodes]);
  const graphMetrics = useMemo(() => {
    const edges = positionedGraph.edges || [];
    const totalUsd = edges
      .map((edge) => Number(edge.usdValue || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0);
    const riskEdges = edges.filter((edge) => {
      const status = edgeAnnotations[edge.id]?.status || "";
      return (
        status === "suspicious" ||
        status === "mixer_flow" ||
        (edge.investigationReasons || []).some((reason) => !["native_value", "stablecoin"].includes(reason.type))
      );
    }).length;
    const providerNames = uniqueValuesClient([
      ...(graphData?.providers || []),
      ...edges.map((edge) => edge.provider).filter(Boolean),
    ]);
    const totalNodes = Number(graphData?.stats?.nodeCount || positionedGraph.nodes.length || 0);
    const visibleRatio = totalNodes ? Math.round((positionedGraph.nodes.length / totalNodes) * 100) : 0;

    return {
      visibleEdges: edges.length,
      visibleNodes: positionedGraph.nodes.length,
      totalUsd,
      riskEdges,
      providerCount: providerNames.length,
      visibleRatio,
    };
  }, [edgeAnnotations, graphData?.providers, graphData?.stats?.nodeCount, positionedGraph.edges, positionedGraph.nodes]);

  const loadGraph = async () => {
    if (!address) {
      return;
    }

    if (!graphStartAt || !graphEndAt || new Date(graphEndAt) <= new Date(graphStartAt)) {
      setError("Укажите правильный период: окончание должно быть позже начала.");
      return;
    }

    setLoading(true);
    setMessage("");
    setError("");

    try {
      const result = await getWalletGraph({
        address,
        networkKey: networkFilter,
        depth,
        maxNodes,
        perAddressLimit,
        startAt: new Date(graphStartAt).toISOString(),
        endAt: new Date(graphEndAt).toISOString(),
        flowDirection: graphFlowDirection,
      });

      setGraphData(result);
      setPositions({});
      setHiddenNodeIds([]);
      setExpandedNodeIds((result.nodes || []).filter((node) => Number(node.depth || 0) < depth).map((node) => node.id));
      setShowAllGraphLayers(true);
      setExpandingNodeIds([]);
      setPinnedNodeIds([]);
      setSuspiciousNodeIds([]);
      setViewport({ x: 120, y: 320, zoom: 1 });
      setSelectedNodeId(result.nodes?.[0]?.id || "");
      setPathStartId("");
      setPathEndId("");
      setInspectorTab("transactions");
      setActiveCaseId("");
      setMessage(
        result.edges?.length
          ? `Цепочка построена: ${result.stats?.nodeCount || result.nodes?.length || 0} адресов, ${result.stats?.edgeCount || result.edges?.length || 0} связей за выбранный период.`
          : "За выбранный период подходящих транзакций не найдено. Расширьте период или выберите «Все направления»."
      );
      setError(result.errors?.length ? result.errors.slice(0, 3).join(" | ") : "");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  const createManualGraph = () => {
    const result = createRootGraph(address, profile, networkFilter, { depth, maxNodes, perAddressLimit });
    setGraphData(result);
    setPositions({});
    setHiddenNodeIds([]);
    setExpandedNodeIds([]);
    setShowAllGraphLayers(false);
    setSelectedNodeId(result.nodes?.[0]?.id || "");
    setInspectorTab("transactions");
    setMessage("Создан пустой граф. Выберите корневой адрес и добавляйте отдельные транзакции вручную.");
    setError("");
  };

  const moveNode = (nodeId, event) => {
    const rect = canvasRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const x = (event.clientX - rect.left - viewport.x) / viewport.zoom;
    const y = (event.clientY - rect.top - viewport.y) / viewport.zoom;

    setPositions((current) => ({
      ...current,
      [nodeId]: { x, y },
    }));
  };

  const startCanvasPan = (event) => {
    if (event.button !== 0 || event.target?.closest?.("[data-graph-node]")) {
      return;
    }

    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanningFrom({ clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y });
  };

  const resetLayout = () => {
    setPositions({});
    setHiddenNodeIds([]);
    setExpandedNodeIds([]);
    setExpandingNodeIds([]);
    setViewport({ x: 120, y: 320, zoom: 1 });
  };

  const fitGraphToView = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const bounds = graphBounds(positionedGraph.nodes || []);

    if (!rect || !bounds) {
      setViewport({ x: 120, y: 320, zoom: 1 });
      return;
    }

    const graphWidth = Math.max(320, bounds.maxX - bounds.minX + 260);
    const graphHeight = Math.max(240, bounds.maxY - bounds.minY + 180);
    const zoom = Math.max(0.32, Math.min(1.15, Math.min(rect.width / graphWidth, rect.height / graphHeight)));

    setViewport({
      x: rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
      y: rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom,
      zoom,
    });
  };

  const resetGraph = () => {
    resetGraphState({
      message: "Граф сброшен. Нажмите «Построить».",
      resetInspector: true,
    });
  };

  const expandNode = async (nodeId) => {
    const node = fullNodeById.get(nodeId) || nodeById.get(nodeId);

    if (!node || expandedNodeIds.includes(nodeId) || expandingNodeIds.includes(nodeId)) {
      return;
    }

    if (Number(node.depth || 0) >= depth) {
      setMessage("Достигнут лимит выбранного режима. Переключитесь на Deep, если нужно раскрывать дальше.");
      return;
    }

    setExpandingNodeIds((current) => current.includes(nodeId) ? current : [...current, nodeId]);
    setMessage(`Загружаю соседей ${shortAddress(node.address)}...`);
    setError("");

    try {
      let result = await getWalletGraphNeighbors({
        address: node.address,
        networkKey: node.networkKey || networkFilter,
        maxNodes: Math.min(80, Math.max(10, perAddressLimit * 3)),
        perAddressLimit,
        startAt: graphStartAt ? new Date(graphStartAt).toISOString() : "",
        endAt: graphEndAt ? new Date(graphEndAt).toISOString() : "",
        flowDirection: graphFlowDirection,
      });
      const canFallbackToAllEvm =
        (node.networkKey || networkFilter) !== "ALL" &&
        (node.networkKey || networkFilter) !== "TRX" &&
        /^0x[a-fA-F0-9]{40}$/.test(node.address);

      if (!result.edges?.length && canFallbackToAllEvm) {
        const fallback = await getWalletGraphNeighbors({
          address: node.address,
          networkKey: "ALL",
          maxNodes: Math.min(80, Math.max(10, perAddressLimit * 3)),
          perAddressLimit,
          startAt: graphStartAt ? new Date(graphStartAt).toISOString() : "",
          endAt: graphEndAt ? new Date(graphEndAt).toISOString() : "",
          flowDirection: graphFlowDirection,
        });

        if (fallback.edges?.length) {
          result = fallback;
        }
      }

      setGraphData((current) => mergeGraphNeighbors(current, result, node));
      setExpandedNodeIds((current) => current.includes(nodeId) ? current : [...current, nodeId]);
      setMessage(
        result.edges?.length
          ? `${shortAddress(node.address)}: добавлено ${Math.max(0, (result.nodes?.length || 1) - 1)} соседей`
          : `${shortAddress(node.address)}: соседей не найдено`
      );
      if (result.errors?.length) {
        setError(result.errors.slice(0, 3).join(" | "));
      }
    } catch (expandError) {
      setError(expandError.message);
      setMessage("");
    } finally {
      setExpandingNodeIds((current) => current.filter((id) => id !== nodeId));
    }
  };

  const addTransactionToGraph = (sourceNode, tx) => {
    if (!sourceNode?.id || !tx?.from || !tx?.to) {
      setError("У транзакции нет адресов from/to, добавить связь в граф нельзя.");
      return;
    }

    let addedEdgeId = "";
    let nextNodeId = "";
    let wasAdded = false;

    setGraphData((current) => {
      const result = mergeManualGraphTransaction(current, sourceNode, tx);
      addedEdgeId = result.edgeId;
      nextNodeId = result.nextNodeId;
      wasAdded = result.added;
      return result.graph;
    });

    setExpandedNodeIds((current) => current.includes(sourceNode.id) ? current : [...current, sourceNode.id]);

    if (addedEdgeId) {
      setSelectedEdgeId(addedEdgeId);
    }

    if (nextNodeId) {
      setSelectedNodeId(nextNodeId);
      setInspectorTab("transactions");
    }

    setMessage(
      wasAdded
        ? `${shortAddress(sourceNode.address)}: добавлена транзакция ${shortAddress(tx.from)} -> ${shortAddress(tx.to)}`
        : "Эта транзакция уже есть в графе."
    );
    setError("");
  };

  const hideNode = (nodeId) => {
    if (!nodeId) return;
    if (pinnedNodeIds.includes(nodeId)) {
      setMessage("Pinned-ноду нельзя скрыть. Сначала снимите pin.");
      return;
    }

    setHiddenNodeIds((current) => current.includes(nodeId) ? current : [...current, nodeId]);

    if (selectedNodeId === nodeId) {
      setSelectedNodeId("");
    }
  };

  const togglePinnedNode = (nodeId) => {
    setPinnedNodeIds((current) =>
      current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]
    );
  };

  const toggleSuspiciousNode = (nodeId) => {
    setSuspiciousNodeIds((current) =>
      current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]
    );
  };

  const updateNodeManualLabel = (nodeId, label) => {
    setGraphData((current) => {
      if (!current?.nodes?.length) {
        return current;
      }

      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                manualLabel: label,
                nametag: label.name || node.nametag,
              }
            : node
        ),
      };
    });
  };

  const updateEdgeAnnotation = (edgeId, patch) => {
    if (!edgeId) return;

    setEdgeAnnotations((current) => ({
      ...current,
      [edgeId]: {
        ...current[edgeId],
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    }));
  };

  const zoomAt = (clientX, clientY, nextZoom) => {
    const rect = canvasRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    setViewport((current) => {
      const zoom = Math.max(0.18, Math.min(3.2, nextZoom));
      const pointerX = clientX - rect.left;
      const pointerY = clientY - rect.top;
      const worldX = (pointerX - current.x) / current.zoom;
      const worldY = (pointerY - current.y) / current.zoom;

      return {
        x: pointerX - worldX * zoom,
        y: pointerY - worldY * zoom,
        zoom,
      };
    });
  };

  const zoomBy = (factor) => {
    const rect = canvasRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewport.zoom * factor);
  };

  const saveCurrentCase = async () => {
    if (!graphData?.nodes?.length) {
      setError("Сначала постройте граф, затем сохраните кейс.");
      return;
    }

    try {
      const edgeCategoryCounts = (graphData.edges || []).reduce((counts, edge) => ({
        ...counts,
        [edge.edgeCategory || "unknown"]: (counts[edge.edgeCategory || "unknown"] || 0) + 1,
      }), {});
      const visibleEdgeCategoryCounts = (positionedGraph.edges || []).reduce((counts, edge) => ({
        ...counts,
        [edge.edgeCategory || "unknown"]: (counts[edge.edgeCategory || "unknown"] || 0) + 1,
      }), {});
      const savedCase = await upsertInvestigationCase({
        id: activeCaseId || undefined,
        title: activeCaseId && restoredCase?.title ? restoredCase.title : `Graph case ${shortAddress(address)} ${new Date().toLocaleDateString("ru-RU")}`,
        rootAddress: address,
        networkKey: networkFilter,
        profileId: activeWorkspaceId,
        severity: pathResult.edgeIds.length ? "High" : "Medium",
        summary: {
          nodes: graphData.stats?.nodeCount || 0,
          edges: graphData.stats?.edgeCount || 0,
          visibleNodes: positionedGraph.nodes?.length || 0,
          visibleEdges: positionedGraph.edges?.length || 0,
          scannedAddresses: graphData.stats?.scannedAddresses || 0,
          pathHops: pathResult.edgeIds.length,
          edgeCategoryCounts,
          visibleEdgeCategoryCounts,
          filters: graphFilters,
          annotations: Object.keys(edgeAnnotations).length,
        },
        graphState: {
          version: 2,
          savedAt: new Date().toISOString(),
          graphData,
          positions,
          hiddenNodeIds,
          expandedNodeIds,
          showAllGraphLayers,
          pinnedNodeIds,
          suspiciousNodeIds,
          edgeAnnotations,
          graphFilters,
          viewport,
          pathStartId,
          pathEndId,
          selectedNodeId,
          selectedEdgeId,
          inspectorTab,
          params: {
            depth,
            graphMode,
            maxNodes,
            networkFilter,
            perAddressLimit,
            startAt: graphStartAt ? new Date(graphStartAt).toISOString() : "",
            endAt: graphEndAt ? new Date(graphEndAt).toISOString() : "",
            flowDirection: graphFlowDirection,
          },
        },
      }, activeWorkspaceId);
      setActiveCaseId(savedCase.id);
      addFeed(`Кейс сохранен: ${savedCase.title}`);
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const exportCurrentCase = () => {
    if (!graphData?.nodes?.length) {
      setError("Сначала постройте граф, затем экспортируйте кейс.");
      return;
    }

    const exportedAt = new Date().toISOString();
    const payload = {
      exportedAt,
      title: restoredCase?.title || `Graph case ${shortAddress(address)}`,
      rootAddress: address,
      networkKey: networkFilter,
      summary: {
        nodes: graphData.stats?.nodeCount || 0,
        edges: graphData.stats?.edgeCount || 0,
        visibleNodes: positionedGraph.nodes?.length || 0,
        visibleEdges: positionedGraph.edges?.length || 0,
        scannedAddresses: graphData.stats?.scannedAddresses || 0,
        pathHops: pathResult.edgeIds.length,
        annotations: Object.keys(edgeAnnotations).length,
      },
      graphState: {
        version: 2,
        savedAt: exportedAt,
        graphData,
        positions,
        hiddenNodeIds,
        expandedNodeIds,
        showAllGraphLayers,
        pinnedNodeIds,
        suspiciousNodeIds,
        edgeAnnotations,
        graphFilters,
        viewport,
        pathStartId,
        pathEndId,
        selectedNodeId,
        selectedEdgeId,
        inspectorTab,
        params: {
          depth,
          graphMode,
          maxNodes,
          networkFilter,
          perAddressLimit,
          startAt: graphStartAt ? new Date(graphStartAt).toISOString() : "",
          endAt: graphEndAt ? new Date(graphEndAt).toISOString() : "",
          flowDirection: graphFlowDirection,
        },
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chainsentinel-case-${shortAddress(address).replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    addFeed(`${address}: JSON export создан`);
  };

  return (
    <section className="graph-shell overflow-hidden rounded-lg border border-sentinel-line bg-black">
      <div className="grid min-h-[calc(100vh-132px)] grid-rows-[auto_minmax(0,1fr)]">
        <div className="graph-toolbar border-b border-zinc-900 bg-ink-950/95 p-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="section-label">AML graph workspace</p>
              <h2 className="mt-1 text-xl font-semibold text-zinc-100">Граф расследования</h2>
              {activeCaseId ? (
                <p className="mt-1 text-xs text-zinc-600">Открыт кейс: {activeCaseId}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <NetworkFilterButtons
                  availableNetworks={availableNetworks}
                  buttonClass="h-8"
                  networkFilter={networkFilter}
                  setNetworkFilter={setNetworkFilter}
                />
                <div className="flex flex-wrap gap-2">
                  {Object.entries(graphModePresets).map(([mode, preset]) => (
                    <button
                      className={`min-h-8 rounded-md border px-3 text-xs transition ${
                        graphMode === mode
                          ? "border-sentinel-green/70 bg-sentinel-green/10 text-sentinel-green"
                          : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-200"
                      }`}
                      key={mode}
                      onClick={() => setGraphMode(mode)}
                      title={preset.description}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-zinc-800 bg-black p-2">
                <label className="grid gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  Период с
                  <input
                    className="control h-9 min-w-[180px] text-xs"
                    onChange={(event) => setGraphStartAt(event.target.value)}
                    type="datetime-local"
                    value={graphStartAt}
                  />
                </label>
                <label className="grid gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  По
                  <input
                    className="control h-9 min-w-[180px] text-xs"
                    onChange={(event) => setGraphEndAt(event.target.value)}
                    type="datetime-local"
                    value={graphEndAt}
                  />
                </label>
                <label className="grid gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  Направление
                  <select
                    aria-label="Направление автоматического графа"
                    className="control h-9 min-w-[170px] text-xs"
                    onChange={(event) => setGraphFlowDirection(event.target.value)}
                    value={graphFlowDirection}
                  >
                    <option value="outgoing">Куда ушли деньги</option>
                    <option value="incoming">Откуда пришли деньги</option>
                    <option value="all">Все направления</option>
                  </select>
                </label>
                {[7, 30, 90].map((days) => (
                  <button
                    className="ghost-button h-9 px-3 text-xs"
                    key={days}
                    onClick={() => {
                      setGraphStartAt(localDateTimeValue(new Date(Date.now() - days * 24 * 60 * 60 * 1000)));
                      setGraphEndAt(localDateTimeValue(new Date()));
                    }}
                    type="button"
                  >
                    {days} дней
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <button className={`primary-button h-9 ${loading ? "button-loading" : ""}`} disabled={loading} onClick={loadGraph} type="button">
                {loading ? <LoadingDots label="Строю цепочки" /> : graphData?.nodes?.length ? "Перестроить цепочки" : "Построить цепочки"}
              </button>
              <button className="ghost-button h-9" disabled={loading} onClick={createManualGraph} type="button">
                Пустой граф
              </button>
              <button className="ghost-button h-9" onClick={saveCurrentCase} type="button">
                {activeCaseId ? "Обновить кейс" : "Сохранить кейс"}
              </button>
              <button className="ghost-button h-9" onClick={exportCurrentCase} type="button">
                Export JSON
              </button>
              <button className="ghost-button h-9" onClick={fitGraphToView} type="button">
                Fit
              </button>
              <button className="ghost-button h-9" onClick={resetLayout} type="button">
                Reset layout
              </button>
              <button className="ghost-button h-9 px-3" onClick={() => zoomBy(0.8)} type="button">
                -
              </button>
              <button className="ghost-button h-9 px-3" onClick={() => zoomBy(1.25)} type="button">
                +
              </button>
              <button className="ghost-button h-9" onClick={resetGraph} type="button">
                Reset
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex flex-wrap gap-2">
              {[
                ["riskOnly", "Risk only"],
                ["hideKnownServices", "Hide ignored"],
              ].map(([key, label]) => (
                <button
                  className={`min-h-8 rounded-md border px-3 text-xs transition ${
                    graphFilters[key]
                      ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                      : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-200"
                  }`}
                  key={key}
                  onClick={() => setGraphFilters((current) => ({ ...current, [key]: !current[key] }))}
                  type="button"
                >
                  {label}
                </button>
              ))}
              {[
                ["mixer", "Mixer"],
                ["exchange", "Exchange"],
                ["bridge", "Bridge"],
                ["service", "Service"],
                ["stablecoin", "Stablecoin"],
                ["native", "Native"],
                ["unknown", "Unknown"],
              ].map(([category, label]) => (
                <button
                  className={`min-h-8 rounded-md border px-3 text-xs transition ${
                    graphFilters.categories?.[category] !== false
                      ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                      : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-200"
                  }`}
                  key={category}
                  onClick={() =>
                    setGraphFilters((current) => ({
                      ...current,
                      categories: {
                        ...defaultGraphFilters.categories,
                        ...(current.categories || {}),
                        [category]: current.categories?.[category] === false,
                      },
                    }))
                  }
                  type="button"
                >
                  <span
                    className="mr-2 inline-block size-2 rounded-full"
                    style={{ backgroundColor: graphEdgeCategoryColor(category) }}
                  />
                  {label}
                </button>
              ))}
              <select
                aria-label="Flow direction"
                className="control h-8 text-xs"
                value={graphFilters.flowDirection}
                onChange={(event) => setGraphFilters((current) => ({ ...current, flowDirection: event.target.value }))}
              >
                <option value="all">All flows</option>
                <option value="in">Incoming to selected</option>
                <option value="out">Outgoing from selected</option>
              </select>
              <input
                aria-label="Minimum USD edge value"
                className="control h-8 w-28 text-xs"
                inputMode="decimal"
                placeholder="Min USD"
                value={graphFilters.minAmount}
                onChange={(event) => setGraphFilters((current) => ({ ...current, minAmount: event.target.value }))}
              />
            </div>
            {graphData?.stats ? (
              <div className="grid grid-cols-6 gap-2 text-xs max-[900px]:grid-cols-3 max-[560px]:grid-cols-2">
                {[
                  ["Flow", graphMetrics.totalUsd ? `$${Math.round(graphMetrics.totalUsd).toLocaleString("en-US")}` : "n/a"],
                  ["Risk edges", graphMetrics.riskEdges],
                  ["Visible", `${graphMetrics.visibleNodes}/${graphMetrics.visibleEdges}`],
                  ["Coverage", `${graphMetrics.visibleRatio}%`],
                  ["Sources", graphMetrics.providerCount || "n/a"],
                  ["Spam hidden", graphData.stats.spamTokenExcludedCount || 0],
                ].map(([label, value]) => (
                  <div className="rounded-md border border-zinc-800 bg-black px-3 py-2" key={label}>
                    <p className="text-[10px] uppercase text-zinc-600">{label}</p>
                    <p className="mt-1 font-semibold text-zinc-100">{value}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {graphData?.dataQuality ? (
            <div className={`mt-3 rounded-md border p-2 text-xs leading-5 ${
              graphData.dataQuality.dataMode === "live" && graphData.dataQuality.completeness === "bounded_window"
                ? "border-sentinel-green/35 bg-sentinel-green/5 text-zinc-400"
                : "border-sentinel-warning/40 bg-sentinel-warning/10 text-sentinel-warning"
            }`}>
              <p>
                Данные графа: {graphData.dataQuality.dataMode === "live" ? "live API" : "кэш"} · полнота: {
                  graphData.dataQuality.completeness === "truncated"
                    ? "ограничена выбранной глубиной или лимитом узлов"
                    : graphData.dataQuality.completeness === "partial"
                      ? "частичная из-за ошибок источников"
                      : "доступное ограниченное окно"
                }
              </p>
              {graphData.dataQuality.warnings?.length ? <p>Ограничения: {graphData.dataQuality.warnings.join(" ")}</p> : null}
            </div>
          ) : null}
          {graphData?.providerErrors?.length || graphData?.scannedNetworks?.length ? (
            <div className="mt-3 rounded-md border border-zinc-800 bg-black p-2 text-xs leading-5 text-zinc-500">
              {graphData.scannedNetworks?.length ? (
                <p>Scanned networks: <span className="text-zinc-300">{graphData.scannedNetworks.join(", ")}</span></p>
              ) : null}
              {graphData.providerErrors?.length ? (
                <p className="text-sentinel-warning">Provider diagnostics: {graphData.providerErrors.slice(0, 4).join(" | ")}</p>
              ) : null}
            </div>
          ) : null}
          {hiddenNodeIds.length || expandedNodeIds.length || (graphData?.nodes?.length > 1 && !showAllGraphLayers) ? (
            <div className="mt-3 flex justify-end gap-2">
              {graphData?.nodes?.length > 1 && !showAllGraphLayers ? (
                <button
                  className="rounded border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={() => {
                    setExpandedNodeIds((graphData.nodes || []).filter((node) => Number(node.depth || 0) < depth).map((node) => node.id));
                    setShowAllGraphLayers(true);
                  }}
                  type="button"
                >
                  Показать все слои
                </button>
              ) : null}
              {expandedNodeIds.length ? (
                <button
                  className="rounded border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={() => {
                    setExpandedNodeIds([]);
                    setShowAllGraphLayers(false);
                  }}
                  type="button"
                >
                  Свернуть до root
                </button>
              ) : null}
              {hiddenNodeIds.length ? (
                <button
                  className="rounded border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={() => setHiddenNodeIds([])}
                  type="button"
                >
                  Показать скрытые ноды
                </button>
              ) : null}
            </div>
          ) : null}

          {pathStartId || pathEndId ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-black p-2 text-xs">
              <span className="text-zinc-500">Path</span>
              <span className="rounded border border-zinc-800 px-2 py-1 text-zinc-300">
                {shortAddress(nodeById.get(pathStartId)?.address || "start")}
              </span>
              <span className="text-zinc-600">to</span>
              <span className="rounded border border-zinc-800 px-2 py-1 text-zinc-300">
                {shortAddress(nodeById.get(pathEndId)?.address || "end")}
              </span>
              <span className={pathResult.edgeIds.length ? "text-sentinel-green" : "text-sentinel-warning"}>
                {pathStartId && pathEndId
                  ? pathResult.edgeIds.length
                    ? `${pathResult.edgeIds.length} hops`
                    : "route not found"
                  : "select start and end"}
              </span>
              <button
                className="ml-auto rounded border border-zinc-800 px-2 py-1 text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setPathStartId("");
                  setPathEndId("");
                }}
                type="button"
              >
                clear
              </button>
            </div>
          ) : null}

          {message ? (
            <div className="mt-3 rounded-md border border-sentinel-warning/40 bg-sentinel-warning/10 p-2 text-xs leading-5 text-sentinel-warning">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="mt-3 rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-2 text-xs leading-5 text-sentinel-danger">
              {error}
            </div>
          ) : null}
        </div>

        <div className="grid min-h-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div
            ref={canvasRef}
            className="graph-canvas relative min-h-[620px] cursor-grab overflow-hidden bg-black active:cursor-grabbing max-[760px]:min-h-[520px]"
            onPointerDown={startCanvasPan}
            onPointerMove={(event) => {
              if (draggingNodeId) {
                moveNode(draggingNodeId, event);
              }

              if (panningFrom) {
                setViewport((current) => ({
                  ...current,
                  x: panningFrom.x + event.clientX - panningFrom.clientX,
                  y: panningFrom.y + event.clientY - panningFrom.clientY,
                }));
              }
            }}
            onPointerUp={(event) => {
              setDraggingNodeId("");
              setPanningFrom(null);
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerLeave={() => {
              setDraggingNodeId("");
              setPanningFrom(null);
            }}
            onWheel={(event) => {
              event.preventDefault();
              zoomAt(event.clientX, event.clientY, viewport.zoom * (event.deltaY > 0 ? 0.88 : 1.14));
            }}
          >
            {loading ? <LoadingOverlay label="Строю граф" /> : expandingNodeIds.length ? <LoadingOverlay label="Загружаю связи" /> : null}

            <div
              className="graph-grid pointer-events-none absolute inset-0 opacity-60"
              style={{
                backgroundImage:
                  "linear-gradient(#141414 1px, transparent 1px), linear-gradient(90deg, #141414 1px, transparent 1px)",
                backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                backgroundSize: `${40 * viewport.zoom}px ${40 * viewport.zoom}px`,
              }}
            />
            <div
              className="pointer-events-none absolute left-0 top-0"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {graphDepths.map((column) => (
                <div
                  className="graph-depth-line absolute top-[-520px] h-[1040px] w-px border-l border-dashed border-zinc-800/80"
                  key={column.depth}
                  style={{ left: `${column.x}px` }}
                >
                  <div className="graph-depth-label absolute left-3 top-0 rounded border border-zinc-800 bg-black/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
                    {column.depth === 0 ? "Исходный кошелёк" : `Hop ${column.depth}`}
                  </div>
                </div>
              ))}
              <svg className="pointer-events-auto absolute left-[-6000px] top-[-6000px] h-[12000px] w-[12000px]" viewBox="-6000 -6000 12000 12000">
                <defs>
                  <marker id="graph-arrow-green" markerHeight="12" markerWidth="12" orient="auto" refX="10" refY="6" markerUnits="userSpaceOnUse">
                    <path d="M1,1 L11,6 L1,11 Z" fill="#2fd16b" stroke="#06120b" strokeWidth="1" />
                  </marker>
                  <marker id="graph-arrow-red" markerHeight="12" markerWidth="12" orient="auto" refX="10" refY="6" markerUnits="userSpaceOnUse">
                    <path d="M1,1 L11,6 L1,11 Z" fill="#f25555" stroke="#160607" strokeWidth="1" />
                  </marker>
                  <marker id="graph-arrow-warning" markerHeight="12" markerWidth="12" orient="auto" refX="10" refY="6" markerUnits="userSpaceOnUse">
                    <path d="M1,1 L11,6 L1,11 Z" fill="#d8a84e" stroke="#171003" strokeWidth="1" />
                  </marker>
                </defs>
                {(positionedGraph.edges || []).map((edge) => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  const isPathEdge = highlightedEdgeIds.has(edge.id);
                  const isSelectedEdge = selectedEdgeId === edge.id;

                  if (!from || !to) {
                    return null;
                  }

                  const isRelatedToSelected = selectedNode && (edge.from === selectedNode.id || edge.to === selectedNode.id);
                  const isOutgoingFromSelected = edge.fromAddress?.toLowerCase() === selectedNode?.address?.toLowerCase();
                  const isOutwardFlow = selectedNode ? isOutgoingFromSelected : Number(to.depth || 0) >= Number(from.depth || 0);
                  const edgeStatus = edgeAnnotations[edge.id]?.status || "";
                  const categoryStroke = graphEdgeCategoryColor(edge.edgeCategory || "unknown");
                  const stroke =
                    edgeStatus === "suspicious" || edgeStatus === "mixer_flow"
                      ? "#f25555"
                      : edgeStatus === "exchange_deposit"
                        ? "#d8a84e"
                        : isPathEdge
                          ? "#d8a84e"
                          : categoryStroke;
                  const markerEnd = isPathEdge
                    ? "url(#graph-arrow-warning)"
                    : isOutwardFlow
                      ? "url(#graph-arrow-red)"
                      : "url(#graph-arrow-green)";
                  const geometry = edgeGeometryById.get(edge.id);

                  if (!geometry) {
                    return null;
                  }

                  return (
                    <g className="cursor-pointer" key={edge.id}>
                      <path
                        d={geometry.path}
                        fill="none"
                        stroke="transparent"
                        strokeLinecap="round"
                        strokeWidth="18"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setSelectedNodeId("");
                          setInspectorTab("edge");
                        }}
                      />
                      <path
                        d={geometry.path}
                        fill="none"
                        markerEnd={markerEnd}
                        pointerEvents="none"
                        stroke={stroke}
                        strokeLinecap="round"
                        strokeOpacity={
                          isSelectedEdge
                            ? "0.98"
                            :
                          highlightedEdgeIds.size
                            ? isPathEdge
                              ? "0.95"
                              : "0.42"
                            : isRelatedToSelected
                              ? "0.9"
                              : "0.72"
                        }
                        strokeWidth={isSelectedEdge ? "5.5" : isPathEdge ? "4.4" : isRelatedToSelected ? "3.4" : "2.4"}
                      />
                      <circle
                        cx={geometry.start.x}
                        cy={geometry.start.y}
                        fill="#050505"
                        pointerEvents="none"
                        r={isSelectedEdge ? "4.2" : "3.2"}
                        stroke={stroke}
                        strokeOpacity={isRelatedToSelected || isSelectedEdge ? "0.95" : "0.64"}
                        strokeWidth="1.6"
                      />
                    </g>
                  );
                })}
              </svg>

              {(positionedGraph.edges || []).map((edge) => {
                const from = nodeById.get(edge.from);
                const to = nodeById.get(edge.to);

                if (!from || !to || !edge.value) {
                  return null;
                }

                const isPathEdge = highlightedEdgeIds.has(edge.id);
                const isRelated = !selectedNode || edge.from === selectedNode.id || edge.to === selectedNode.id;
                const geometry = edgeGeometryById.get(edge.id);

                if (!geometry || (!isPathEdge && !isRelated)) {
                  return null;
                }

                const isOutgoing = edge.fromAddress?.toLowerCase() === selectedNode?.address?.toLowerCase();
                const numericTimestamp = Number(edge.timestamp);
                const edgeTimestamp = Number.isFinite(numericTimestamp) && numericTimestamp > 0
                  ? (numericTimestamp < 10_000_000_000 ? numericTimestamp * 1000 : numericTimestamp)
                  : Date.parse(edge.timestamp || "");
                const edgeTimeLabel = Number.isFinite(edgeTimestamp)
                  ? new Date(edgeTimestamp).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
                  : "";

                return (
                  <div
                    className={`graph-edge-label pointer-events-none absolute max-w-56 -translate-x-1/2 -translate-y-1/2 rounded border px-2 py-1 text-[10px] font-semibold shadow-panel ${
                      isPathEdge
                        ? "border-sentinel-warning/50 bg-black/95 text-sentinel-warning"
                        : isOutgoing
                        ? "border-sentinel-danger/40 bg-black/90 text-sentinel-danger"
                        : "border-zinc-700 bg-black/90 text-zinc-300"
                    }`}
                    key={`${edge.id}-label`}
                    style={{
                      left: `${geometry.label.x}px`,
                      opacity: highlightedEdgeIds.size ? (isPathEdge ? 1 : 0.42) : isRelated ? 1 : 0.5,
                      top: `${geometry.label.y}px`,
                    }}
                    title={`${edge.fromAddress || from.address} -> ${edge.toAddress || to.address}: ${edge.value}`}
                  >
                    <span className="block truncate">
                      {shortAddress(edge.fromAddress || from.address)}
                      {" -> "}
                      {shortAddress(edge.toAddress || to.address)}
                    </span>
                    <span className="block truncate text-[9px] font-medium text-zinc-500">{edge.value}</span>
                    {edgeTimeLabel ? <span className="block truncate text-[9px] font-normal text-zinc-600">{edgeTimeLabel}</span> : null}
                  </div>
                );
              })}

              {(positionedGraph.nodes || []).map((node) => {
                const isSelected = node.id === selectedNodeId;
                const isPathNode = highlightedNodeIds.has(node.id);
                const expandableCount = expandableChildCounts.get(node.id) || 0;
                const isExpanded = expandedNodeSet.has(node.id);
                const isExpanding = expandingNodeSet.has(node.id);
                const canLazyExpand = false;

                return (
                  <button
                    data-graph-node="true"
                    className={`graph-node pointer-events-auto absolute grid h-10 min-w-24 max-w-36 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center rounded-md border bg-ink-900 px-3 text-xs font-semibold shadow-panel transition hover:border-zinc-400 hover:text-zinc-100 ${
                      node.suspicious
                        ? "border-sentinel-danger text-sentinel-danger ring-2 ring-sentinel-danger/20"
                        : node.pinned
                          ? "border-sentinel-warning text-sentinel-warning ring-2 ring-sentinel-warning/20"
                          : isPathNode
                        ? "border-sentinel-warning text-sentinel-warning ring-2 ring-sentinel-warning/20"
                        : isSelected
                          ? "border-sentinel-green text-sentinel-green ring-2 ring-sentinel-green/20"
                          : node.tone
                    } ${isExpanding ? "graph-node-loading" : ""}`}
                    key={node.id}
                    onClick={() => {
                      setSelectedNodeId(node.id);
                      setSelectedEdgeId("");
                      setInspectorTab("transactions");
                    }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      setSelectedNodeId(node.id);
                      setSelectedEdgeId("");
                      if (node.pinned) {
                        return;
                      }
                      setDraggingNodeId(node.id);
                      moveNode(node.id, event);
                    }}
                    style={{
                      height: `${node.size || 36}px`,
                      left: `${node.x}px`,
                      minWidth: `${Math.max(96, (node.size || 36) * 2.9)}px`,
                      top: `${node.y}px`,
                    }}
                    title={`${node.networkName || node.networkKey}: ${node.address}`}
                    type="button"
                  >
                    <span className="max-w-full truncate">{node.label}</span>
                    <span className="text-[10px] font-normal text-zinc-600">
                      {isExpanding
                        ? <LoadingDots label="loading" />
                        : node.pinned
                        ? "pinned"
                        : node.suspicious
                          ? "suspicious"
                          : node.secondaryLabel || `${node.networkKey}${node.txCount ? ` · ${node.txCount} tx` : ""}`}
                    </span>
                    {canLazyExpand || expandableCount ? (
                      <span className={`absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded border px-1 text-[10px] ${
                        isExpanding
                          ? "border-sentinel-warning/50 bg-sentinel-warning/15 text-sentinel-warning"
                          : isExpanded
                          ? "border-sentinel-green/50 bg-sentinel-green/15 text-sentinel-green"
                          : "border-zinc-700 bg-black text-zinc-400"
                      }`}>
                        {isExpanding ? "..." : isExpanded ? expandableCount || "ok" : expandableCount ? `+${expandableCount}` : "+"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {(positionedGraph.nodes || []).map((node) => {
                if (node.id !== hoveredNodeId || node.depth === 0) {
                  return null;
                }

                return (
                  <button
                    className="pointer-events-auto absolute -translate-x-1/2 rounded border border-zinc-700 bg-black px-2 py-1 text-[10px] font-semibold text-zinc-400 shadow-panel hover:border-sentinel-danger/60 hover:text-sentinel-danger"
                    key={`${node.id}-hide`}
                    onClick={(event) => {
                      event.stopPropagation();
                      hideNode(node.id);
                    }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    style={{
                      left: `${node.x}px`,
                      top: `${node.y + (node.size || 36) / 2 + 12}px`,
                    }}
                    type="button"
                  >
                    скрыть
                  </button>
                );
              })}
            </div>

            <div className="graph-zoom-hint pointer-events-none absolute bottom-3 left-3 rounded-md border border-zinc-800 bg-black/80 px-3 py-2 text-xs text-zinc-500">
              Zoom {(viewport.zoom * 100).toFixed(0)}% · click node for transactions · add selected tx · drag canvas · wheel zoom
            </div>

            {!graphData?.nodes?.length ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div>
                  <p className="text-sm font-semibold text-zinc-300">Граф еще не построен</p>
                  <p className="mt-2 max-w-md text-xs leading-5 text-zinc-500">
                    Выберите период и направление, затем нажмите «Построить цепочки». Проект автоматически покажет исходный кошелёк, его переводы и следующие адреса по слоям Hop.
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          <GraphInspector
            addFeed={addFeed}
            addedGraphTxIds={addedGraphTxIds}
            addTransactionToGraph={addTransactionToGraph}
            graphData={graphData}
            node={selectedNode}
            selectedEdge={selectedEdge}
            selectedEdgeAnnotation={selectedEdge ? edgeAnnotations[selectedEdge.id] : null}
            pathEndId={pathEndId}
            pathResult={pathResult}
            pathStartId={pathStartId}
            saveWatchlistRule={saveWatchlistRule}
            selectedEdges={selectedEdges}
            hideNode={hideNode}
            pinnedNodeIds={pinnedNodeIds}
            suspiciousNodeIds={suspiciousNodeIds}
            setPathEndId={setPathEndId}
            setPathStartId={setPathStartId}
            tab={inspectorTab}
            setTab={setInspectorTab}
            togglePinnedNode={togglePinnedNode}
            toggleSuspiciousNode={toggleSuspiciousNode}
            updateNodeManualLabel={updateNodeManualLabel}
            updateEdgeAnnotation={updateEdgeAnnotation}
            openWalletProfile={openWalletProfile}
          />
        </div>
      </div>
    </section>
  );
}

function GraphInspector({
  addFeed,
  addedGraphTxIds,
  addTransactionToGraph,
  graphData,
  node,
  selectedEdge,
  selectedEdgeAnnotation,
  pathEndId,
  pathResult,
  pathStartId,
  saveWatchlistRule,
  selectedEdges,
  hideNode,
  pinnedNodeIds,
  suspiciousNodeIds,
  setPathEndId,
  setPathStartId,
  tab,
  setTab,
  togglePinnedNode,
  toggleSuspiciousNode,
  updateNodeManualLabel,
  updateEdgeAnnotation,
  openWalletProfile,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const [nodeTransactions, setNodeTransactions] = useState([]);
  const [nodeTxPage, setNodeTxPage] = useState(1);
  const [nodeTxHasMore, setNodeTxHasMore] = useState(false);
  const [nodeTxProvider, setNodeTxProvider] = useState("");
  const [nodeTxLoadingMore, setNodeTxLoadingMore] = useState(false);
  const [nodeAnalysis, setNodeAnalysis] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [labelCategory, setLabelCategory] = useState("service");
  const [labelName, setLabelName] = useState("");
  const [labelConfidence, setLabelConfidence] = useState("85");
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState("");
  const [edgeNote, setEdgeNote] = useState("");
  const incoming = selectedEdges.filter((edge) => edge.to === node?.id);
  const outgoing = selectedEdges.filter((edge) => edge.from === node?.id);
  const counterparties = new Set(
    selectedEdges.map((edge) => (edge.from === node?.id ? edge.toAddress : edge.fromAddress)).filter(Boolean)
  );
  const tabs = [
    ["profile", "Профиль"],
    ["transactions", "Транзакции"],
    ["stats", "Статистика"],
    ["edge", "Связь"],
  ];
  const nodeTransactionNetworkKey = node?.networkKey || graphData?.networkKey || "ETH";

  useEffect(() => {
    let cancelled = false;

    async function loadNodeDetails() {
      if (!node?.address) {
        setSnapshot(null);
        setNodeTransactions([]);
        setNodeAnalysis(null);
        setNodeTxPage(1);
        setNodeTxHasMore(false);
        setNodeTxProvider("");
        setDetailsError("");
        return;
      }

      setLoadingDetails(true);
      setDetailsError("");
      setSnapshot(null);
      setNodeTransactions([]);
      setNodeAnalysis(null);
      setNodeTxPage(1);
      setNodeTxHasMore(false);
      setNodeTxProvider("");

      const txNetworkKey = nodeTransactionNetworkKey;
      const snapshotNetworkKey = txNetworkKey === "ALL" ? "ETH" : txNetworkKey;
      const detailErrors = [];
      let pendingRequests = 2;
      const pushDetailsError = (message) => {
        if (!message || cancelled) {
          return;
        }

        detailErrors.push(message);
        setDetailsError(detailErrors.join(" | "));
      };
      const finishRequest = () => {
        if (!cancelled) {
          pendingRequests -= 1;
          if (pendingRequests <= 0) {
            setLoadingDetails(false);
          }
        }
      };

      Promise.resolve()
        .then(() => getWalletLiveProfile(node.address).then((result) => (
          result.candidates?.find((candidate) => candidate.networkKey === snapshotNetworkKey) || result.selected
        )))
        .then((snapshotResult) => {
          if (!cancelled) {
            setSnapshot(snapshotResult);
          }
        })
        .catch((loadError) => {
          if (!cancelled) {
            setSnapshot(null);
            pushDetailsError(loadError.message);
          }
        })
        .finally(finishRequest);

      Promise.resolve()
        .then(() => listWalletTransactions({
          address: node.address,
          networkKey: txNetworkKey,
          page: 1,
          limit: 50,
        }))
        .then((txResult) => {
          if (!cancelled) {
            setNodeTransactions(txResult.items || []);
            setNodeAnalysis(txResult.analysis || null);
            setNodeTxPage(1);
            setNodeTxHasMore(Boolean(txResult.hasMore));
            setNodeTxProvider(txResult.provider || txResult.cacheProvider || "");
          }
        })
        .catch((loadError) => {
          if (!cancelled) {
            setNodeTransactions([]);
            setNodeAnalysis(null);
            setNodeTxPage(1);
            setNodeTxHasMore(false);
            setNodeTxProvider("");
            pushDetailsError(loadError.message);
          }
        })
        .finally(finishRequest);
    }

    loadNodeDetails();

    return () => {
      cancelled = true;
    };
  }, [node?.address, node?.networkKey, nodeTransactionNetworkKey]);

  const loadMoreNodeTransactions = async () => {
    if (!node?.address || nodeTxLoadingMore || !nodeTxHasMore) {
      return;
    }

    const nextPage = nodeTxPage + 1;
    setNodeTxLoadingMore(true);
    setDetailsError("");

    try {
      const result = await listWalletTransactions({
        address: node.address,
        networkKey: nodeTransactionNetworkKey,
        page: nextPage,
        limit: 50,
      });

      setNodeTransactions((current) => {
        const seen = new Set(current.map(graphTransactionKey));
        const nextItems = (result.items || []).filter((tx) => {
          const key = graphTransactionKey(tx);

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);
          return true;
        });

        return [...current, ...nextItems];
      });
      setNodeTxPage(nextPage);
      setNodeTxHasMore(Boolean(result.hasMore));
      setNodeTxProvider(result.provider || result.cacheProvider || nodeTxProvider);
      if (result.analysis) {
        setNodeAnalysis(result.analysis);
      }
    } catch (loadError) {
      setDetailsError(loadError.message);
    } finally {
      setNodeTxLoadingMore(false);
    }
  };

  useEffect(() => {
    setLabelName(node?.nametag || "");
    setLabelError("");
  }, [node?.address, node?.nametag]);

  useEffect(() => {
    setEdgeNote(selectedEdgeAnnotation?.note || "");
  }, [selectedEdge?.id, selectedEdgeAnnotation?.note]);

  const addNodeToWatchlist = async () => {
    if (!node?.address) {
      return;
    }

    const rule = await saveWatchlistRule({
      address: node.address,
      networkName: node.networkName || node.networkKey,
      eventType: "Любое движение",
      amountLimit: "any",
      channel: "graph",
      active: true,
    });
    addFeed(`${rule.address}: добавлен в watchlist из графа`);
  };

  const saveNodeLabel = async ({ category = labelCategory, name = labelName, confidence = labelConfidence, markSuspicious = false } = {}) => {
    if (!node?.address) {
      return;
    }

    setSavingLabel(true);
    setLabelError("");

    try {
      const saved = await upsertEntityLabel({
        address: node.address,
        category,
        name: name || node.nametag || shortAddress(node.address),
        networkKey: node.networkKey || "UNKNOWN",
        confidence,
        source: markSuspicious ? "graph-suspicious" : "graph-manual",
      });

      if (markSuspicious && !suspiciousNodeIds.includes(node.id)) {
        toggleSuspiciousNode(node.id);
      }

      updateNodeManualLabel(node.id, saved);

      if (!labelName) {
        setLabelName(saved.name);
      }

      addFeed(`${node.address}: сохранена метка ${saved.category}`);
    } catch (saveError) {
      setLabelError(saveError.message);
    } finally {
      setSavingLabel(false);
    }
  };

  const isPinned = node ? pinnedNodeIds.includes(node.id) : false;
  const isSuspicious = node ? suspiciousNodeIds.includes(node.id) : false;
  const toggleNodeSuspicious = () => {
    if (isSuspicious) {
      toggleSuspiciousNode(node.id);
      return;
    }

    saveNodeLabel({ category: "scam", name: labelName || "Suspicious address", confidence: 90, markSuspicious: true });
  };

  return (
    <aside className="graph-inspector min-h-0 border-l border-zinc-900 bg-ink-950 max-[1024px]:border-l-0 max-[1024px]:border-t">
      <div className="flex h-full min-h-[620px] flex-col">
        <div className="border-b border-zinc-900 p-4">
          <p className="section-label">Node inspector</p>
          {node ? (
            <>
              <h3 className="mt-2 text-lg font-semibold text-zinc-100">{shortAddress(node.address)}</h3>
              <p className="mt-2 break-all text-xs leading-5 text-zinc-500">{node.address}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-400">{node.networkName || node.networkKey}</span>
                {node.depth === 0 ? (
                  <span className="rounded border border-sentinel-green/40 bg-sentinel-green/10 px-2 py-1 text-xs text-sentinel-green">Target</span>
                ) : (
                  <span className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-400">Counterparty</span>
                )}
                {loadingDetails ? (
                  <span className="rounded border border-sentinel-green/30 bg-sentinel-green/10 px-2 py-1 text-xs text-sentinel-green">
                    <LoadingDots label="loading" />
                  </span>
                ) : null}
              </div>
              {detailsError ? (
                <p className="mt-3 text-xs leading-5 text-sentinel-warning">{detailsError}</p>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-sm leading-6 text-zinc-500">Выберите узел на графе, чтобы открыть данные адреса.</p>
          )}
        </div>

        <div className="flex border-b border-zinc-900 p-2">
          {tabs.map(([id, label]) => (
            <button
              className={`min-h-9 flex-1 rounded-md text-xs ${
                tab === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
              key={id}
              onClick={() => setTab(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!node && !selectedEdge ? (
            <div className="rounded-lg border border-zinc-800 bg-black p-4 text-sm text-zinc-500">
              После построения графа нажмите на любой адрес.
            </div>
          ) : null}

          {selectedEdge && tab === "edge" ? (
            <div className="grid gap-3">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Selected edge</p>
                <p className="mt-2 text-lg font-semibold text-zinc-100">{selectedEdge.value}</p>
                {selectedEdge.usdValue ? (
                  <p className="mt-1 text-sm font-semibold text-sentinel-green">${selectedEdge.usdValue.toLocaleString("en-US")}</p>
                ) : null}
                <p className="mt-2 text-xs text-zinc-500">
                  {selectedEdge.networkName || selectedEdge.networkKey} · {selectedEdge.tokenType || "native"}
                  {selectedEdge.txCount ? ` · ${selectedEdge.txCount} tx` : ""}
                </p>
                <p className="mt-2 inline-flex rounded border border-zinc-700 bg-ink-950 px-2 py-1 text-xs text-zinc-300">
                  Category: {selectedEdge.edgeCategory || "unknown"}
                </p>
                {selectedEdge.provider ? (
                  <p className="mt-2 text-xs text-zinc-600">Provider: {selectedEdge.provider}</p>
                ) : null}
                {selectedEdgeAnnotation?.status ? (
                  <p className="mt-2 inline-flex rounded border border-sentinel-warning/40 bg-sentinel-warning/10 px-2 py-1 text-xs text-sentinel-warning">
                    {selectedEdgeAnnotation.status}
                  </p>
                ) : null}
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Edge workflow</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    ["suspicious", "Suspicious"],
                    ["exchange_deposit", "Exchange deposit"],
                    ["mixer_flow", "Mixer flow"],
                    ["ignored", "Ignore noise"],
                  ].map(([status, label]) => (
                    <button
                      className={`ghost-button min-h-9 ${selectedEdgeAnnotation?.status === status ? "border-sentinel-warning text-sentinel-warning" : ""}`}
                      key={status}
                      onClick={() => updateEdgeAnnotation(selectedEdge.id, { status })}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <textarea
                  aria-label="Analyst note for this edge"
                  className="control mt-3 min-h-24 resize-none py-3 text-xs"
                  onChange={(event) => setEdgeNote(event.target.value)}
                  placeholder="Analyst note for this edge"
                  value={edgeNote}
                />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    className="primary-button min-h-9"
                    onClick={() => updateEdgeAnnotation(selectedEdge.id, { note: edgeNote })}
                    type="button"
                  >
                    Save note
                  </button>
                  <button
                    className="ghost-button min-h-9"
                    onClick={() => updateEdgeAnnotation(selectedEdge.id, { status: "", note: "" })}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Route</p>
                <p className="mt-2 break-all text-xs leading-5 text-zinc-400">{selectedEdge.fromAddress}</p>
                <p className="my-2 text-xs text-zinc-600">to</p>
                <p className="break-all text-xs leading-5 text-zinc-400">{selectedEdge.toAddress}</p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Why this edge is shown</p>
                <div className="mt-3 grid gap-2">
                  {(selectedEdge.investigationReasons || []).map((reason) => (
                    <div className="rounded-md border border-zinc-900 bg-ink-950 p-2" key={`${reason.type}-${reason.title}`}>
                      <p className="text-xs font-semibold text-zinc-200">{reason.title}</p>
                      <p className="mt-1 text-xs leading-5 text-zinc-500">{reason.description}</p>
                    </div>
                  ))}
                  {!selectedEdge.investigationReasons?.length ? (
                    <p className="text-xs text-zinc-500">Edge selected by graph relevance rules.</p>
                  ) : null}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Transactions</p>
                <div className="mt-3 grid gap-2">
                  {(selectedEdge.txHashes || [selectedEdge.hash]).slice(0, 8).map((hash) => (
                    <a
                      className="truncate rounded border border-zinc-900 bg-ink-950 px-2 py-2 text-xs text-zinc-400 hover:text-sentinel-green"
                      href={selectedEdge.explorerUrl || "#"}
                      key={hash}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {hash}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {node && tab === "profile" ? (
            <div className="grid gap-3">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Node actions</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button
                    className={`ghost-button min-h-9 ${isPinned ? "border-sentinel-warning text-sentinel-warning" : ""}`}
                    onClick={() => togglePinnedNode(node.id)}
                    type="button"
                  >
                    {isPinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    className={`ghost-button min-h-9 ${isSuspicious ? "border-sentinel-danger text-sentinel-danger" : ""}`}
                    onClick={toggleNodeSuspicious}
                    disabled={savingLabel}
                    type="button"
                  >
                    {isSuspicious ? "Clear risk" : "Mark risk"}
                  </button>
                  <button
                    className="ghost-button min-h-9"
                    disabled={isPinned}
                    onClick={() => hideNode(node.id)}
                    type="button"
                  >
                    Hide
                  </button>
                </div>
                {isPinned ? (
                  <p className="mt-2 text-xs leading-5 text-zinc-500">Pinned-нода не скрывается и не перетаскивается.</p>
                ) : null}
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Адрес</p>
                <p className="mt-2 break-all text-sm font-semibold text-zinc-100">{node.address}</p>
              </div>
              {node.nametag ? (
                <div className="rounded-lg border border-sentinel-green/30 bg-sentinel-green/5 p-3">
                  <p className="text-xs text-zinc-500">Arkham nametag</p>
                  <p className="mt-2 text-sm font-semibold text-sentinel-green">{node.nametag}</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                    {(node.arkham?.entities || []).slice(0, 2).map((item) => (
                      <span className="rounded border border-zinc-800 bg-black px-2 py-1" key={`entity-${item.name}`}>{item.name}</span>
                    ))}
                    {(node.arkham?.labels || []).slice(0, 2).map((item) => (
                      <span className="rounded border border-zinc-800 bg-black px-2 py-1" key={`label-${item.name}`}>{item.name}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Баланс</p>
                  <p className="mt-2 text-lg font-semibold text-zinc-100">
                    {loadingDetails ? <span className="skeleton-line inline-block h-5 w-24" /> : snapshot ? `${snapshot.balance} ${snapshot.symbol}` : "not loaded"}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Tx count</p>
                  <p className="mt-2 text-lg font-semibold text-zinc-100">
                    {loadingDetails ? <span className="skeleton-line inline-block h-5 w-16" /> : snapshot?.txCount ?? node.txCount ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Входящие</p>
                  <p className="mt-2 text-2xl font-semibold text-sentinel-green">{incoming.length}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Исходящие</p>
                  <p className="mt-2 text-2xl font-semibold text-sentinel-danger">{outgoing.length}</p>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">AML risk score</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <p className="min-w-20 text-4xl font-semibold text-zinc-100">
                    {loadingDetails ? <span className="skeleton-line inline-block h-10 w-16" /> : nodeAnalysis?.riskScore ?? "n/a"}
                  </p>
                  <p className="text-xs leading-5 text-zinc-500">
                    {loadingDetails ? <LoadingDots label="анализ" /> : nodeAnalysis?.summary
                      ? `${nodeAnalysis.summary.fastTransferCount || 0} fast · ${nodeAnalysis.summary.exitCandidateCount || 0} exits · ${nodeAnalysis.summary.mixerHitCount || 0} mixer`
                    : "загрузите транзакции адреса"}
                  </p>
                </div>
              </div>
              {nodeAnalysis?.riskFactors?.length ? (
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Ключевые факторы</p>
                  <div className="mt-3 grid gap-2">
                    {nodeAnalysis.riskFactors.slice(0, 4).map((factor) => (
                      <div className="rounded-md border border-zinc-900 bg-ink-950 p-2" key={`${factor.type}-${factor.txHashes?.[0] || factor.title}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-zinc-200">{factor.title}</p>
                          <span className="text-xs text-sentinel-warning">{factor.points} pts</span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{factor.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Manual label</p>
                <div className="mt-3 grid gap-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
                    <select className="control min-h-9" value={labelCategory} onChange={(event) => setLabelCategory(event.target.value)}>
                      <option value="service">service</option>
                      <option value="exchange">exchange</option>
                      <option value="bridge">bridge</option>
                      <option value="mixer">mixer</option>
                      <option value="scam">scam</option>
                      <option value="sanctions">sanctions</option>
                      <option value="victim">victim</option>
                      <option value="attacker">attacker</option>
                    </select>
                    <input aria-label="Label confidence" className="control min-h-9" value={labelConfidence} onChange={(event) => setLabelConfidence(event.target.value)} />
                  </div>
                  <input
                    aria-label="Название метки"
                    className="control min-h-9"
                    placeholder="Название метки"
                    value={labelName}
                    onChange={(event) => setLabelName(event.target.value)}
                  />
                  <button className="primary-button min-h-9" disabled={savingLabel} onClick={() => saveNodeLabel()} type="button">
                    {savingLabel ? "Сохранение..." : "Добавить label"}
                  </button>
                </div>
                {labelError ? <p className="mt-2 text-xs leading-5 text-sentinel-danger">{labelError}</p> : null}
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Live data</p>
                <div className="mt-3 grid gap-2 text-xs text-zinc-400">
                  <span>Latest block: {snapshot?.blockNumber ?? "not loaded"}</span>
                  <span>
                    Latest activity:{" "}
                    {snapshot?.latestActivityAt ? new Date(snapshot.latestActivityAt).toLocaleString("ru-RU") : "not loaded"}
                  </span>
                  <span>Source: {snapshot?.source || "not loaded"}</span>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Маршрут расследования</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    className={`ghost-button min-h-9 ${pathStartId === node.id ? "border-sentinel-warning text-sentinel-warning" : ""}`}
                    onClick={() => setPathStartId(node.id)}
                    type="button"
                  >
                    Start
                  </button>
                  <button
                    className={`ghost-button min-h-9 ${pathEndId === node.id ? "border-sentinel-warning text-sentinel-warning" : ""}`}
                    onClick={() => setPathEndId(node.id)}
                    type="button"
                  >
                    End
                  </button>
                </div>
                <p className="mt-3 text-xs leading-5 text-zinc-500">
                  {pathStartId && pathEndId
                    ? pathResult.edgeIds.length
                      ? `Найден путь: ${pathResult.edgeIds.length} hops`
                      : "Путь между выбранными адресами не найден в текущем графе"
                    : "Выберите стартовый и конечный узел"}
                </p>
              </div>
              <button className="ghost-button min-h-10" onClick={addNodeToWatchlist} type="button">
                Добавить в watchlist
              </button>
              <button className="primary-button min-h-10" onClick={() => openWalletProfile?.(node.address)} type="button">
                Открыть полный профиль
              </button>
            </div>
          ) : null}

          {node && tab === "transactions" ? (
            <div className="grid gap-2">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-zinc-500">Транзакции выбранной ноды</p>
                    <p className="mt-1 text-sm leading-5 text-zinc-300">
                      Добавляйте в граф только те связи, которые нужны для расследования.
                    </p>
                  </div>
                  <span className="shrink-0 rounded border border-zinc-800 bg-ink-950 px-2 py-1 text-xs text-zinc-400">
                    {nodeTransactions.length} tx
                  </span>
                </div>
                {nodeTxProvider ? <p className="mt-2 text-xs text-zinc-600">Source: {nodeTxProvider}</p> : null}
              </div>
              {loadingDetails && !nodeTransactions.length ? (
                Array.from({ length: 4 }, (_, index) => (
                  <div className="rounded-lg border border-zinc-800 bg-black p-3" key={`node-tx-skeleton-${index}`}>
                    <SkeletonBlock lines={3} />
                  </div>
                ))
              ) : nodeTransactions.length ? (
                nodeTransactions.map((tx) => {
                  const txKey = graphTransactionKey(tx);
                  const txHash = tx.txHash || tx.hash || "";
                  const alreadyAdded = Boolean(addedGraphTxIds?.has(txKey) || (txHash && addedGraphTxIds?.has(txHash)));
                  const canAdd = Boolean(tx.from && tx.to);
                  const direction = String(tx.direction || "").toLowerCase();
                  const selectedAddress = String(node.address || "").toLowerCase();
                  const counterparty = String(tx.from || "").toLowerCase() === selectedAddress ? tx.to : tx.from;
                  const tokenLabel = tx.tokenSymbol || (tx.tokenType === "native" ? tx.networkKey : tx.tokenType) || "asset";
                  const category = graphTransactionCategory(tx);

                  return (
                    <div className="soft-enter overflow-safe rounded-lg border border-zinc-800 bg-black p-3" key={txKey}>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded border px-2 py-0.5 font-semibold ${
                            direction === "out"
                              ? "border-sentinel-danger/40 bg-sentinel-danger/10 text-sentinel-danger"
                              : "border-sentinel-green/35 bg-sentinel-green/10 text-sentinel-green"
                          }`}>
                            {direction || "flow"}
                          </span>
                          <span className="rounded border border-zinc-800 bg-ink-950 px-2 py-0.5 text-zinc-500">{category}</span>
                        </div>
                        <span className="text-zinc-500">{tx.networkName || tx.networkKey}</span>
                      </div>
                      <p className="mt-2 break-all text-sm font-semibold text-zinc-200">
                        {shortAddress(tx.from)} {"->"} {shortAddress(tx.to)}
                      </p>
                      <p className="mt-1 break-all text-[11px] text-zinc-600">
                        counterparty: <span className="text-zinc-400">{counterparty || "unknown"}</span>
                      </p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
                        <span>{tx.value || tokenLabel}</span>
                        {tx.usdValue ? <span className="text-sentinel-green">${Number(tx.usdValue).toLocaleString("en-US")}</span> : null}
                        <span>{tx.timestamp ? new Date(tx.timestamp).toLocaleString("ru-RU") : ""}</span>
                      </div>
                      <TransactionRiskTags flags={nodeAnalysis?.transactionFlags?.[txHash] || []} />
                      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_112px] items-center gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs text-zinc-600">{txHash || "no hash"}</p>
                          {tx.explorerUrl ? (
                            <a className="mt-1 block text-[11px] text-sentinel-green hover:text-green-300" href={tx.explorerUrl} rel="noreferrer" target="_blank">
                              explorer
                            </a>
                          ) : null}
                        </div>
                        <button
                          className={`min-h-9 rounded-md border px-3 text-xs font-semibold transition ${
                            alreadyAdded
                              ? "border-sentinel-green/40 bg-sentinel-green/10 text-sentinel-green"
                              : "border-zinc-700 bg-ink-950 text-zinc-300 hover:border-sentinel-green/60 hover:text-sentinel-green"
                          }`}
                          disabled={!canAdd || alreadyAdded}
                          onClick={() => addTransactionToGraph?.(node, tx)}
                          type="button"
                        >
                          {alreadyAdded ? "В графе" : "Добавить"}
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : selectedEdges.map((edge) => (
                <div className="rounded-lg border border-zinc-800 bg-black p-3" key={edge.id}>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className={edge.from === node.id ? "text-sentinel-danger" : "text-sentinel-green"}>
                      {edge.from === node.id ? "out" : "in"}
                    </span>
                    <span className="text-zinc-500">{edge.networkName}</span>
                  </div>
                  <p className="mt-2 truncate text-sm font-semibold text-zinc-200">
                    {shortAddress(edge.fromAddress)} {"->"} {shortAddress(edge.toAddress)}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-zinc-500">
                    <span>{edge.value}</span>
                    {edge.usdValue ? <span className="text-sentinel-green">${edge.usdValue.toLocaleString("en-US")}</span> : null}
                    <span>{edge.provider || (edge.timestamp ? new Date(edge.timestamp).toLocaleString("ru-RU") : "")}</span>
                  </div>
                  {edge.explorerUrl ? (
                    <a className="mt-2 block text-xs text-sentinel-green hover:text-green-300" href={edge.explorerUrl} rel="noreferrer" target="_blank">
                      explorer
                    </a>
                  ) : null}
                </div>
              ))}
              {!selectedEdges.length && !nodeTransactions.length ? (
                <div className="rounded-lg border border-zinc-800 bg-black p-4 text-sm text-zinc-500">
                  По этому узлу в загруженном графе нет ребер.
                </div>
              ) : null}
              {nodeTxHasMore ? (
                <button className="ghost-button min-h-10" disabled={nodeTxLoadingMore} onClick={loadMoreNodeTransactions} type="button">
                  {nodeTxLoadingMore ? <LoadingDots label="Загружаю" /> : "Загрузить еще транзакции"}
                </button>
              ) : null}
            </div>
          ) : null}

          {node && tab === "stats" ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Связей</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{selectedEdges.length}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Контрагентов</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{counterparties.size}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Fast transfer</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{nodeAnalysis?.summary?.fastTransferCount || 0}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Exit candidates</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{nodeAnalysis?.summary?.exitCandidateCount || 0}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Fan-out</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{nodeAnalysis?.summary?.fanOutCount || 0}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Fan-in</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{nodeAnalysis?.summary?.fanInCount || 0}</p>
                </div>
              </div>
              {nodeAnalysis?.signals?.length ? (
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">AML signals</p>
                  <div className="mt-3 grid gap-2">
                    {nodeAnalysis.signals.map((signal) => (
                      <div className="rounded-md border border-zinc-900 bg-ink-950 p-2" key={signal.type}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-zinc-200">{signal.title}</p>
                          <span className={signal.severity === "high" ? "text-xs text-sentinel-danger" : "text-xs text-sentinel-warning"}>
                            {signal.confidence}%
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{signal.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {nodeAnalysis?.suspiciousRoutes?.length ? (
                <div className="rounded-lg border border-zinc-800 bg-black p-3">
                  <p className="text-xs text-zinc-500">Маршруты</p>
                  <div className="mt-3 grid gap-2">
                    {nodeAnalysis.suspiciousRoutes.slice(0, 4).map((route) => (
                      <div className="rounded-md border border-zinc-900 bg-ink-950 p-2" key={`${route.type}-${route.txHashes.join("-")}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-zinc-200">{route.title}</p>
                          <span className="text-xs text-sentinel-warning">{route.confidence}%</span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{route.reason}</p>
                        <p className="mt-1 text-[11px] text-zinc-600">{route.stepCount} tx</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Address flow</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  {[
                    ["Incoming", incoming.length],
                    ["Outgoing", outgoing.length],
                    ["Counterparties", counterparties.size],
                    ["Risk routes", nodeAnalysis?.summary?.suspiciousRouteCount || 0],
                  ].map(([label, value]) => (
                    <div className="rounded-md border border-zinc-900 bg-ink-950 p-2" key={label}>
                      <p className="text-[10px] uppercase text-zinc-600">{label}</p>
                      <p className="mt-1 font-semibold text-zinc-100">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="text-xs text-zinc-500">Контрагенты</p>
                <div className="mt-3 grid gap-2">
                  {[...counterparties].slice(0, 12).map((item) => (
                    <p className="truncate text-xs text-zinc-400" key={item}>{item}</p>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}


function MixerExitAnalysis({ address, profile, addFeed, saveWatchlistRule }) {
  const [networkFilter, setNetworkFilter] = useState(defaultProfileNetwork(profile));
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLastReport, setLoadingLastReport] = useState(false);
  const [error, setError] = useState("");
  const [savingAddress, setSavingAddress] = useState("");
  const [chainDepth, setChainDepth] = useState(2);
  const [saveChainEntities, setSaveChainEntities] = useState(true);
  const [scanStatus, setScanStatus] = useState("");

  useEffect(() => {
    setNetworkFilter(defaultProfileNetwork(profile));
    setAnalysis(null);
    setError("");
  }, [address, profile.networkKey]);

  const availableNetworks = profileNetworkOptions(profile);

  const loadAnalysis = async () => {
    if (!address) {
      return;
    }

    setLoading(true);
    setError("");
    setScanStatus("Root address");

    try {
      const result = await getMixerChainScan({
        address,
        networkKey: networkFilter,
        depth: chainDepth,
        maxPerHop: 4,
        limit: 80,
        saveEntities: saveChainEntities,
      });
      const nextAnalysis = result.analysis || null;
      setAnalysis(nextAnalysis ? { ...nextAnalysis, savedReport: result.report || null } : null);
      if (nextAnalysis?.savedEntities?.length) {
        addFeed?.(`Chain scan: saved ${nextAnalysis.savedEntities.length} entity labels`);
      }
      setScanStatus(nextAnalysis?.chain?.length ? `Chain checked: ${nextAnalysis.chain.length} hops` : "Root checked");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setScanStatus("");
    }
  };

  const loadLastReport = async () => {
    if (!address) {
      return;
    }

    setLoadingLastReport(true);
    setError("");

    try {
      const report = await getLatestMixerChainScan({
        address,
        networkKey: networkFilter,
      });
      const nextAnalysis = report.result?.analysis || null;
      setAnalysis(nextAnalysis ? { ...nextAnalysis, savedReport: report } : null);
      addFeed?.(`Chain scan report loaded: ${report.id}`);
    } catch (loadError) {
      setError(loadError.message === "HTTP 404" ? "Сохраненный chain scan отчет для этого адреса не найден." : loadError.message);
    } finally {
      setLoadingLastReport(false);
    }
  };

  const chainItems = analysis?.chain || [];
  const savedEntities = analysis?.savedEntities || [];
  const chainCandidates = chainItems.flatMap((item) =>
    (item.analysis?.exitCandidates || []).map((candidate) => ({
      ...candidate,
      parentAddress: item.address,
      depth: item.depth + 1,
    }))
  );
  const candidates = [...(analysis?.exitCandidates || []), ...chainCandidates].filter((candidate, index, list) =>
    index === list.findIndex((item) => String(item.address || "").toLowerCase() === String(candidate.address || "").toLowerCase())
  );
  const chainAnalyses = chainItems.map((item) => item.analysis).filter(Boolean);
  const allSignals = [...(analysis?.signals || []), ...chainAnalyses.flatMap((item) => item.signals || [])];
  const allRiskFactors = [...(analysis?.riskFactors || []), ...chainAnalyses.flatMap((item) => item.riskFactors || [])];
  const allRoutes = [...(analysis?.suspiciousRoutes || []), ...chainAnalyses.flatMap((item) => item.suspiciousRoutes || [])];
  const mixerSignals = allSignals.filter((signal) =>
    ["known_mixer_contact", "mixer_to_exchange", "mixer_heuristic_engine", "mixer_equalized_withdrawal"].includes(signal.type)
  );
  const structuralFactors = allRiskFactors.filter((factor) =>
    /structured_|fresh_wallet_fanout|pool_like_flow|equalized_withdrawal_cluster|bridge_to_exchange/.test(factor.type || "")
  );
  const mixerRoutes = allRoutes.filter((route) => /mixer|bridge_to_exchange|pool_like|structured/.test(route.type || ""));
  const mixerConfidence = Math.max(analysis?.summary?.mixerHeuristicConfidence || 0, ...chainAnalyses.map((item) => item.summary?.mixerHeuristicConfidence || 0));
  const confirmedMixerTx = (analysis?.summary?.mixerHitCount || 0) + chainAnalyses.reduce((sum, item) => sum + (item.summary?.mixerHitCount || 0), 0);
  const chainScan = analysis?.chainScan || {};
  const reportMeta = analysis?.savedReport || (chainScan.reportId ? { id: chainScan.reportId, createdAt: chainScan.reportSavedAt } : null);
  const evidenceItems = [
    ...mixerSignals.map((item) => ({ ...item, evidenceGroup: "confirmed" })),
    ...structuralFactors.map((item) => ({ ...item, evidenceGroup: "structural" })),
  ];
  const scanStateLabel = loading
    ? scanStatus || "Scanning"
    : loadingLastReport
      ? "Loading report"
      : reportMeta
        ? "Saved report"
        : analysis
          ? "Scan ready"
          : "Ready";
  const scanStateClass = mixerConfidence
    ? "border-sentinel-danger/50 bg-sentinel-danger/10 text-sentinel-danger"
    : analysis
      ? "border-sentinel-green/40 bg-sentinel-green/10 text-sentinel-green"
      : "border-zinc-800 bg-black text-zinc-500";

  const watchCandidate = async (candidate) => {
    setSavingAddress(candidate.address);
    setError("");

    try {
      const rule = await saveWatchlistRule({
        address: candidate.address,
        networkName: candidate.networkName || profile.name,
        eventType: "Вероятный exit-address",
        amountLimit: "any",
        channel: "mixer-exit",
        active: true,
      });
      addFeed(`${rule.address}: добавлен как вероятный exit-address`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSavingAddress("");
    }
  };

  return (
    <section className="panel overflow-safe p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="section-label">Mixer chain scan</p>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${scanStateClass}`}>
              {scanStateLabel}
            </span>
          </div>
          <h2 className="mt-2 text-xl font-semibold text-zinc-100">Строгая проверка цепочки и exit-address</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-500">
            Скан идет по найденным exit-candidates, сохраняет подтвержденные Arkham entity в локальную базу и отделяет
            confirmed mixer evidence от слабых структурных паттернов.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button className={`ghost-button min-h-10 ${loadingLastReport ? "button-loading" : ""}`} disabled={loading || loadingLastReport} onClick={loadLastReport} type="button">
            {loadingLastReport ? <LoadingDots label="Loading" /> : "Last report"}
          </button>
          <button className={`primary-button min-h-10 ${loading ? "button-loading" : ""}`} disabled={loading || loadingLastReport} onClick={loadAnalysis} type="button">
            {loading ? <LoadingDots label="Анализ" /> : "Запустить проверку"}
          </button>
        </div>
      </div>

      <div className="overflow-safe mt-5 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <NetworkFilterButtons
          availableNetworks={availableNetworks}
          networkFilter={networkFilter}
          setNetworkFilter={setNetworkFilter}
        />
        <div className="overflow-safe flex flex-wrap gap-2 xl:justify-end">
          <div className="flex min-h-10 items-center gap-1 rounded-md border border-zinc-800 bg-black p-1 text-xs text-zinc-500">
            <span className="px-2">Depth</span>
            {[1, 2, 3].map((depth) => (
              <button
                className={`h-8 rounded px-3 text-xs font-semibold transition ${
                  chainDepth === depth ? "bg-sentinel-green text-black" : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-200"
                }`}
                key={depth}
                onClick={() => setChainDepth(depth)}
                type="button"
              >
                {depth} hop{depth > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-zinc-800 bg-black px-3 text-xs text-zinc-500">
            <input
              checked={saveChainEntities}
              className="accent-sentinel-green"
              onChange={(event) => setSaveChainEntities(event.target.checked)}
              type="checkbox"
            />
            Save entities
          </label>
        </div>
      </div>

      {loading && scanStatus ? (
        <div className="mt-4 border-y border-zinc-900 py-3 text-xs text-zinc-500">
          Chain scan is running: <span className="text-zinc-300">{scanStatus}</span>
        </div>
      ) : null}

      {reportMeta ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-zinc-900 py-3 text-xs text-zinc-600">
          <span>Report <span className="font-semibold text-zinc-300">{reportMeta.id}</span></span>
          <span>{reportMeta.createdAt ? new Date(reportMeta.createdAt).toLocaleString("ru-RU") : "saved"}</span>
          {chainScan.checkedAddresses ? <span>checked {chainScan.checkedAddresses} addresses</span> : null}
          {chainScan.errorCount ? <span className="text-sentinel-warning">{chainScan.errorCount} scan errors</span> : null}
        </div>
      ) : null}

      {loading && !analysis ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div className="panel-subtle p-3" key={item}>
              <SkeletonBlock lines={2} />
            </div>
          ))}
        </div>
      ) : analysis ? (
        <div className="soft-enter overflow-safe mt-5 grid rounded-md border border-zinc-900 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["Risk score", analysis.riskScore ?? 0, "общий риск"],
            ["Mixer confidence", `${mixerConfidence}%`, confirmedMixerTx ? `${confirmedMixerTx} known mixer tx` : "нет known mixer hit"],
            ["Exit-address", candidates.length, "кандидаты для мониторинга"],
            ["Structural patterns", structuralFactors.length, "не считаются mixer без label"],
            ["Chain hops", chainItems.length, `${analysis.chainScan?.savedEntityCount || savedEntities.length} saved · ${analysis.chainScan?.existingEntityCount || 0} known`],
          ].map(([label, value, caption]) => (
            <div className="min-h-24 border-b border-r border-zinc-900 p-4 last:border-r-0 sm:[&:nth-child(2n)]:border-r-0 xl:border-b-0 xl:[&:nth-child(2n)]:border-r xl:[&:last-child]:border-r-0" key={label}>
              <p className="text-xs text-zinc-500">{label}</p>
              <p className={`mt-1 text-2xl font-semibold ${label === "Mixer confidence" && mixerConfidence ? "text-sentinel-danger" : "text-zinc-100"}`}>{value}</p>
              <p className="mt-1 text-xs text-zinc-600">{caption}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 border-y border-zinc-800 py-4 text-sm leading-6 text-zinc-500">
          Запустите проверку, чтобы увидеть confirmed mixer hits, структурные flow-паттерны и возможные exit-address. Результаты
          строятся только по загруженной истории транзакций и локальной базе меток.
        </div>
      )}

      {analysis ? (
        <div className={`mt-4 border-l-2 py-1 pl-3 text-xs leading-5 ${mixerConfidence ? "border-sentinel-danger text-sentinel-danger" : "border-zinc-700 text-zinc-500"}`}>
          {mixerConfidence
            ? `Confirmed mixer evidence: confidence ${mixerConfidence}% · known mixer tx ${confirmedMixerTx}`
            : "Confirmed mixer evidence: not found. Structural patterns below are not treated as mixer proof."}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">
          {error}
        </div>
      ) : null}

      {analysis ? (
        <div className="overflow-safe mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          <div className="min-w-0 space-y-5">
            <div>
              <div className="flex items-end justify-between gap-3 border-b border-zinc-800 pb-2">
                <div>
                  <p className="section-label">Chain path</p>
                  <h3 className="mt-1 text-sm font-semibold text-zinc-100">Проверенные hop-адреса</h3>
                </div>
                <span className="text-xs text-zinc-600">{chainItems.length} hops</span>
              </div>

              {chainItems.length ? (
                <div className="mt-3 grid gap-0">
                  {chainItems.slice(0, 10).map((item, index) => (
                    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3" key={`${item.depth}-${item.address}`}>
                      <div className="relative flex justify-center">
                        <span className="mt-1 grid size-6 place-items-center rounded-full border border-zinc-800 bg-black text-[10px] font-semibold text-zinc-400">
                          {item.depth}
                        </span>
                        {index < Math.min(chainItems.length, 10) - 1 ? <span className="absolute top-7 h-full w-px bg-zinc-900" /> : null}
                      </div>
                      <div className="min-w-0 max-w-full border-b border-zinc-900 pb-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-overflow-safe break-all text-sm font-semibold text-zinc-200">{item.address}</p>
                          {item.entityLabel ? (
                            <span className="rounded border border-sentinel-green/30 bg-sentinel-green/10 px-2 py-0.5 text-[11px] text-sentinel-green">
                              {item.entityStatus === "saved" ? "saved" : "known"} · {item.entityLabel.name}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-zinc-600">
                          from {shortAddress(item.parentAddress)} · {item.networkKey || "network"} · probability {item.probability || 0}%
                        </p>
                        {item.error ? <p className="mt-1 text-xs text-sentinel-warning">{item.error}</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 border-b border-zinc-900 pb-4 text-sm text-zinc-500">Цепочка пока не расширялась за root address.</p>
              )}
            </div>

            <div>
              <div className="flex items-end justify-between gap-3 border-b border-zinc-800 pb-2">
                <div>
                  <p className="section-label">Evidence ledger</p>
                  <h3 className="mt-1 text-sm font-semibold text-zinc-100">Что реально найдено</h3>
                </div>
                <span className="text-xs text-zinc-600">{evidenceItems.length} items</span>
              </div>

              <div className="mt-3 grid gap-2">
                {evidenceItems.slice(0, 10).map((item, index) => (
                  <article className="border-b border-zinc-900 pb-3 last:border-b-0" key={`${item.type}-${index}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${
                        item.evidenceGroup === "confirmed"
                          ? "border-sentinel-danger/40 bg-sentinel-danger/10 text-sentinel-danger"
                          : "border-sentinel-warning/40 bg-sentinel-warning/10 text-sentinel-warning"
                      }`}>
                        {item.evidenceGroup}
                      </span>
                      <p className="text-sm font-semibold text-zinc-200">{item.title}</p>
                      <span className="text-xs text-zinc-600">{item.confidence || item.points || 0}{item.confidence ? "% confidence" : " pts"}</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{item.description}</p>
                    {item.txHashes?.length ? (
                      <p className="mt-1 break-all text-[11px] text-zinc-700">tx: {item.txHashes.slice(0, 3).map(shortAddress).join(", ")}</p>
                    ) : null}
                  </article>
                ))}
                {!evidenceItems.length ? (
                  <p className="py-4 text-sm text-zinc-500">Нет confirmed mixer evidence и нет сильных структурных flow-паттернов.</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="overflow-safe">
            <div className="flex items-end justify-between gap-3 border-b border-zinc-800 pb-2">
              <div>
                <p className="section-label">Exit candidates</p>
                <h3 className="mt-1 text-sm font-semibold text-zinc-100">Адреса для наблюдения</h3>
              </div>
              <span className="text-xs text-zinc-600">{candidates.length}</span>
            </div>

            <div className="overflow-safe mt-3 grid gap-3">
              {candidates.length ? candidates.map((candidate) => (
                <article className="overflow-safe rounded-md border border-zinc-800 bg-black/50 p-3 transition hover:border-zinc-700" key={`${candidate.networkName || profile.name}-${candidate.address}`}>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                    <div className="overflow-safe">
                      <p className="text-overflow-safe break-all text-sm font-semibold leading-5 text-zinc-200">{candidate.address}</p>
                      <p className="text-overflow-safe mt-1 break-words text-xs text-zinc-600">
                        {candidate.networkName || profile.name} · tx {candidate.txHash ? shortAddress(candidate.txHash) : "n/a"}
                        {candidate.depth ? ` · hop ${candidate.depth}` : ""}
                        {candidate.parentAddress ? ` · from ${shortAddress(candidate.parentAddress)}` : ""}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded border px-2.5 py-1 text-sm font-semibold ${
                      candidate.probability >= 85
                        ? "border-sentinel-danger/40 bg-sentinel-danger/10 text-sentinel-danger"
                        : "border-sentinel-warning/40 bg-sentinel-warning/10 text-sentinel-warning"
                    }`}>
                      {candidate.probability}%
                    </span>
                  </div>
                  <p className="text-overflow-safe mt-2 break-words text-xs leading-5 text-zinc-500">{candidate.reason}</p>
                  <button
                    className="ghost-button mt-3 min-h-8 w-full"
                    disabled={savingAddress === candidate.address}
                    onClick={() => watchCandidate(candidate)}
                    type="button"
                  >
                    {savingAddress === candidate.address ? <LoadingDots label="Сохраняю" /> : "Следить"}
                  </button>
                </article>
              )) : (
                <p className="py-4 text-sm text-zinc-500">Exit-address кандидаты для выбранной сети не найдены.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TelegramAlerts(props) {
  const { enabled, setEnabled, feed, addFeed, address, networkName, saveWatchlistRule, pollWatchlist } = props;
  const [telegramId, setTelegramId] = useState("");
  const [limit, setLimit] = useState("any");
  const [eventType, setEventType] = useState("Любое движение");
  const [assetScope, setAssetScope] = useState("all");
  const [hideSpamTokens, setHideSpamTokens] = useState(true);

  const submit = async (event) => {
    event.preventDefault();
    const rule = await saveWatchlistRule({
      address,
      networkName,
      eventType,
      amountLimit: limit,
      assetScope,
      hideSpamTokens,
      telegramChatId: telegramId,
      channel: "telegram",
      active: enabled,
    });
    addFeed(`Правило Telegram сохранено: ${rule.address}, ${rule.eventType}`);
  };

  const runPoll = async () => {
    try {
      await pollWatchlist();
    } catch (error) {
      addFeed(`Watchlist poll error: ${error.message}`);
    }
  };

  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Alerts</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Telegram-уведомления</h2>
        </div>
        <button
          className={`h-7 w-12 rounded-full border p-1 transition ${
            enabled ? "border-sentinel-green/50 bg-sentinel-green/20" : "border-zinc-700 bg-black"
          }`}
          onClick={() => setEnabled(!enabled)}
          type="button"
          aria-label="Переключить Telegram-уведомления"
        >
          <span
            className={`block size-5 rounded-full transition ${enabled ? "translate-x-5 bg-sentinel-green" : "bg-zinc-600"}`}
          />
        </button>
      </div>

      <form className="mt-4 grid gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-xs text-zinc-500">
          Telegram chat ID
          <input aria-label="Telegram chat ID" className="control min-h-10" placeholder="123456789 or @channel" value={telegramId} onChange={(event) => setTelegramId(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-zinc-500">
          Порог суммы
          <input aria-label="Порог суммы" className="control min-h-10" value={limit} onChange={(event) => setLimit(event.target.value)} />
        </label>
        <p className="text-xs leading-5 text-zinc-600">
          Для EVM-адресов правило «Любое движение» проверяет все подключенные EVM-сети. Используйте `any`, чтобы не ограничивать сумму.
        </p>
        <label className="grid gap-1 text-xs text-zinc-500">
          Событие
          <select className="control min-h-10" value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option>Любое движение</option>
            <option>Входящий перевод</option>
            <option>Исходящий перевод</option>
            <option>Контакт с миксером</option>
            <option>Вероятный exit-address</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-zinc-500">
          Активы
          <select className="control min-h-10" value={assetScope} onChange={(event) => setAssetScope(event.target.value)}>
            <option value="all">Все движения</option>
            <option value="native">Только native coin</option>
            <option value="tokens">Только токены</option>
          </select>
        </label>
        <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-zinc-800 bg-black px-3 text-xs text-zinc-400">
          <span>Скрывать spam-token / claim / airdrop</span>
          <input
            checked={hideSpamTokens}
            onChange={(event) => setHideSpamTokens(event.target.checked)}
            type="checkbox"
          />
        </label>
        <button className="primary-button min-h-10" type="submit">
          Сохранить правило
        </button>
        <button className="ghost-button min-h-10" type="button" onClick={runPoll}>
          Проверить сейчас
        </button>
      </form>

      <div className="mt-4 grid gap-2">
        {feed.map((item, index) => (
          <div className="rounded-md border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-400" key={`${item}-${index}`}>
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

function displayWalletNetwork(item) {
  return /^0x[a-fA-F0-9]{40}$/.test(item?.address || "") ? "EVM" : item?.networkName;
}

const displayMonitoringNetwork = displayWalletNetwork;

function latestAlertForRule(rule, alertEvents) {
  return alertEvents.find((event) => event.ruleId === rule.id || event.address?.toLowerCase() === rule.address?.toLowerCase());
}

function formatAlertStatus(event) {
  if (!event) {
    return "нет событий";
  }

  if (event.telegram?.delivered) {
    return "доставлено";
  }

  return event.telegram?.reason || "не отправлено";
}

function formatRuleFilters(rule) {
  const parts = [];
  if (rule.assetScope && rule.assetScope !== "all") {
    parts.push(rule.assetScope === "native" ? "native" : "tokens");
  }
  if (rule.hideSpamTokens !== false && /^0x[a-fA-F0-9]{40}$/.test(rule.address || "")) {
    parts.push("anti-spam");
  }
  return parts.join(", ") || "all";
}

function alertDirectionLabel(event) {
  const direction = event.current?.latestDirection;
  if (direction === "out") {
    return "Исходящее";
  }
  if (direction === "in") {
    return "Входящее";
  }
  return event.eventType || "Событие";
}

function alertDeliveryClass(event) {
  if (event.telegram?.delivered) {
    return "border-sentinel-green/40 text-sentinel-green";
  }
  return "border-sentinel-danger/40 text-sentinel-danger";
}

function AlertEventsPanel({ events = [] }) {
  const deliveredCount = events.filter((event) => event.telegram?.delivered).length;
  const failedCount = events.filter((event) => event.telegram && !event.telegram.delivered).length;
  const latestEvent = events[0];

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-label">Alert journal</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Журнал уведомлений</h2>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right text-xs max-[640px]:w-full max-[640px]:text-left">
          <div className="rounded-md border border-zinc-800 bg-black px-3 py-2">
            <p className="text-zinc-600">Всего</p>
            <p className="mt-1 text-base font-semibold text-zinc-100">{events.length}</p>
          </div>
          <div className="rounded-md border border-zinc-800 bg-black px-3 py-2">
            <p className="text-zinc-600">Доставлено</p>
            <p className="mt-1 text-base font-semibold text-sentinel-green">{deliveredCount}</p>
          </div>
          <div className="rounded-md border border-zinc-800 bg-black px-3 py-2">
            <p className="text-zinc-600">Ошибки</p>
            <p className="mt-1 text-base font-semibold text-sentinel-danger">{failedCount}</p>
          </div>
        </div>
      </div>

      {latestEvent ? (
        <div className="mt-4 rounded-md border border-zinc-800 bg-black p-3 text-xs text-zinc-500">
          Последний alert: {new Date(latestEvent.createdAt).toLocaleString("ru-RU")} · {latestEvent.networkName || "unknown"} · {formatAlertStatus(latestEvent)}
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500">
              <th className="py-3 pr-3 font-medium">Время</th>
              <th className="py-3 pr-3 font-medium">Сеть</th>
              <th className="py-3 pr-3 font-medium">Тип</th>
              <th className="py-3 pr-3 font-medium">Адрес</th>
              <th className="py-3 pr-3 font-medium">Сумма</th>
              <th className="py-3 pr-3 font-medium">Tx</th>
              <th className="py-3 pr-3 font-medium">Telegram</th>
              <th className="py-3 pr-3 font-medium">Ссылка</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const txHash = event.current?.latestTxId || "";
              const explorerUrl = event.current?.latestExplorerUrl || "";

              return (
                <tr className="border-b border-zinc-900 last:border-b-0" key={event.id}>
                  <td className="py-3 pr-3 text-zinc-500">{event.createdAt ? new Date(event.createdAt).toLocaleString("ru-RU") : "unknown"}</td>
                  <td className="py-3 pr-3 text-zinc-400">{event.networkName || "unknown"}</td>
                  <td className="py-3 pr-3 text-zinc-500">{alertDirectionLabel(event)}</td>
                  <td className="py-3 pr-3 font-semibold text-zinc-200">
                    {shortAddress(event.address)}
                    {event.current?.counterpartyEntity ? (
                      <p className="mt-1 text-xs font-normal text-sentinel-warning">→ {event.current.counterpartyEntity.name} · {traceExitTypeLabel(event.current.counterpartyExitType)}</p>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-zinc-500">{event.current?.latestValue || event.amountLimit || "n/a"}</td>
                  <td className="py-3 pr-3 text-zinc-500">{txHash ? shortAddress(txHash) : "n/a"}</td>
                  <td className="py-3 pr-3">
                    <span className={`rounded-full border px-2 py-1 text-xs ${alertDeliveryClass(event)}`}>
                      {formatAlertStatus(event)}
                    </span>
                  </td>
                  <td className="py-3 pr-3">
                    {explorerUrl ? (
                      <a className="ghost-button inline-flex min-h-8 items-center" href={explorerUrl} rel="noreferrer" target="_blank">
                        Открыть
                      </a>
                    ) : (
                      <span className="text-zinc-600">нет ссылки</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!events.length ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
            Уведомлений пока нет. Нажмите «Проверить сейчас» или дождитесь следующего poll.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WatchlistPanel({ address, networkName, addFeed, rules, alertEvents = [], removeRule, saveRule }) {
  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Watchlist</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Адреса под наблюдением</h2>
        </div>
        <button
          className="primary-button min-h-10"
          onClick={async () => {
            const rule = await saveRule({
              address,
              networkName,
              eventType: "Любое движение",
              amountLimit: "any",
              assetScope: "all",
              hideSpamTokens: true,
              channel: "dashboard",
              active: true,
            });
            addFeed(`${rule.address}: добавлено правило наблюдения`);
          }}
          type="button"
        >
          Добавить текущий
        </button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500">
              <th className="py-3 pr-3 font-medium">Адрес</th>
              <th className="py-3 pr-3 font-medium">Сеть</th>
              <th className="py-3 pr-3 font-medium">Правило</th>
              <th className="py-3 pr-3 font-medium">Порог</th>
              <th className="py-3 pr-3 font-medium">Фильтры</th>
              <th className="py-3 pr-3 font-medium">Статус</th>
              <th className="py-3 pr-3 font-medium">Последний alert</th>
              <th className="py-3 pr-3 font-medium">Действие</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const latestAlert = latestAlertForRule(rule, alertEvents);
              const delivered = latestAlert?.telegram?.delivered;

              return (
                <tr className="border-b border-zinc-900 last:border-b-0" key={rule.id}>
                  <td className="py-3 pr-3 font-semibold text-zinc-200">{rule.address}</td>
                  <td className="py-3 pr-3 text-zinc-400">{displayMonitoringNetwork(rule)}</td>
                  <td className="py-3 pr-3 text-zinc-500">{rule.eventType}</td>
                  <td className="py-3 pr-3 text-zinc-500">{rule.amountLimit || "any"}</td>
                  <td className="py-3 pr-3 text-zinc-500">{formatRuleFilters(rule)}</td>
                  <td className="py-3 pr-3">
                    <span
                      className={`rounded-full border px-2 py-1 text-xs ${
                        rule.active
                          ? "border-sentinel-green/40 text-sentinel-green"
                          : "border-zinc-700 text-zinc-500"
                      }`}
                    >
                      {rule.active ? "active" : "paused"}
                    </span>
                  </td>
                  <td className="py-3 pr-3">
                    <div className={delivered ? "text-sentinel-green" : "text-zinc-500"}>
                      {formatAlertStatus(latestAlert)}
                    </div>
                    {latestAlert?.createdAt ? (
                      <div className="mt-1 text-xs text-zinc-600">{new Date(latestAlert.createdAt).toLocaleString("ru-RU")}</div>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3">
                    <div className="flex flex-wrap gap-2">
                      <button className="ghost-button min-h-8 text-sentinel-danger" onClick={() => removeRule(rule)} type="button">
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rules.length ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm text-zinc-500">
            Правил наблюдения пока нет.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function isSanctionsEntityLabel(label) {
  const category = String(label?.category || "").toLowerCase();
  const source = String(label?.source || "").toLowerCase();
  const notes = String(label?.notes || "").toLowerCase();

  return category.includes("sanction") || source.startsWith("ofac-sls") || notes.includes("ofac");
}

function isRiskDatabaseLabel(label) {
  const category = String(label?.category || "").toLowerCase();

  return isSanctionsEntityLabel(label) || ["scam", "benign"].includes(category);
}

function entitySourceLabel(label) {
  const source = String(label?.source || "").trim();

  if (!source) return "manual";
  if (source.startsWith("ofac-sls:")) return `OFAC SLS: ${source.replace(/^ofac-sls:/, "")}`;
  if (source === "poison-hunter:ccs24") return "Poison-Hunter CCS 2024";
  if (source === "poison-hunter:phishing_transfers_sample.csv") return "Poison-Hunter sample transfers";
  if (source === "etherscan:benign_labels:poison-hunter") return "Etherscan benign labels via Poison-Hunter";
  if (source === "fbi-dprk-tradertraitor:2023-08-22") return "FBI DPRK TraderTraitor, 2023-08-22";
  return source;
}

function entitySourceGroup(label) {
  const source = String(label?.source || "").toLowerCase();

  if (source.startsWith("ofac-sls:")) return "ofac";
  if (source.startsWith("poison-hunter:")) return "poison";
  if (source.startsWith("etherscan:")) return "etherscan";
  if (source.startsWith("fbi-")) return "fbi";
  return "manual";
}

function attributionTypeLabel(type) {
  const labels = {
    exchange: "Биржа / кастодиальный сервис",
    mixer: "Миксер",
    bridge: "Мост",
    dex: "Децентрализованный обменник",
    payment_service: "Платёжный сервис",
    gambling: "Азартный сервис",
    sanctioned_entity: "Санкционная организация",
    reported_illicit: "Адрес с сообщениями о мошенничестве",
    known_entity: "Известная организация",
  };

  return labels[type] || "Не установлено";
}

function ExchangeAttributionPage({ address, addFeed, openWallet }) {
  const [input, setInput] = useState(address || "");
  const [networkKey, setNetworkKey] = useState("AUTO");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [manual, setManual] = useState({
    address: "",
    name: "",
    networkKey: "TRX",
    confidence: 85,
    source: "",
    notes: "",
  });

  useEffect(() => {
    if (address && !input.trim()) setInput(address);
  }, [address]);

  const parsedAddresses = () => [...new Set(input.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean))];

  const runAttribution = async (addresses = parsedAddresses()) => {
    setError("");

    if (!addresses.length) {
      setError("Введите хотя бы один адрес кошелька.");
      return;
    }

    if (addresses.length > 200) {
      setError("За одну проверку можно обработать не более 200 адресов.");
      return;
    }

    setLoading(true);

    try {
      const result = await attributeAddresses({ addresses, networkKey });
      setReport(result);
      addFeed?.(`Биржи: проверено ${result.summary.total}, установлено бирж ${result.summary.exchanges}`);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  const saveManualExchange = async (event) => {
    event.preventDefault();
    setError("");

    if (!manual.address.trim() || !manual.name.trim() || !manual.source.trim()) {
      setError("Для ручной метки обязательны адрес, название биржи и проверяемый источник.");
      return;
    }

    setLoading(true);

    try {
      await upsertEntityLabel({
        ...manual,
        address: manual.address.trim(),
        name: manual.name.trim(),
        source: manual.source.trim(),
        notes: manual.notes.trim(),
        confidence: Number(manual.confidence || 85),
        category: "exchange",
      });
      const nextAddresses = parsedAddresses();
      if (!nextAddresses.some((value) => value.toLowerCase() === manual.address.trim().toLowerCase())) {
        nextAddresses.push(manual.address.trim());
        setInput(nextAddresses.join("\n"));
      }
      await runAttribution(nextAddresses);
      addFeed?.(`Добавлена биржевая метка ${manual.name}: ${shortAddress(manual.address)}`);
      setManual((current) => ({ ...current, address: "", name: "", source: "", notes: "" }));
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setLoading(false);
    }
  };

  const copyAddress = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${shortAddress(value)} скопирован`);
    } catch {
      setCopyStatus("Не удалось скопировать");
    }
  };

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <p className="section-label">ATTRIBUTION / ПРИНАДЛЕЖНОСТЬ</p>
        <h2 className="mt-1 text-xl font-semibold text-zinc-100">Какой бирже принадлежит адрес</h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-400">
          Проверка сравнивает адреса с локальной базой известных организаций. Метка биржи указывает на сервис, который контролирует
          адрес, но не раскрывает владельца конкретного аккаунта. ФИО и документы клиента можно получить только официальным запросом
          в биржу с адресом, хешем транзакции, суммой и временем.
        </p>
        <div className="mt-4 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm leading-6 text-amber-200">
          «Не установлено» не означает, что адрес безопасен или не связан с биржей — в локальной базе просто нет подтверждённой метки.
          Поведение переводов само по себе не является доказательством принадлежности бирже.
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px_auto]">
          <textarea
            className="control min-h-32 resize-y"
            onChange={(event) => setInput(event.target.value)}
            placeholder="Вставьте один адрес или список — по одному в строке"
            value={input}
          />
          <label className="grid content-start gap-2 text-xs text-zinc-500">
            Сеть
            <select className="control min-h-11" onChange={(event) => setNetworkKey(event.target.value)} value={networkKey}>
              <option value="AUTO">Определить автоматически</option>
              <option value="TRX">TRON (TRX / TRC-20)</option>
              <option value="ETH">EVM / Ethereum</option>
              <option value="BTC">Bitcoin</option>
            </select>
          </label>
          <button className={`primary-button min-h-11 self-start ${loading ? "button-loading" : ""}`} disabled={loading} onClick={() => runAttribution()} type="button">
            {loading ? <LoadingDots label="Проверяем" /> : "Определить биржу"}
          </button>
        </div>
        {error ? <div className="mt-3 rounded-md border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">{error}</div> : null}
      </section>

      {report ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {[
              ["Проверено", report.summary.total],
              ["Биржи", report.summary.exchanges],
              ["Другие известные", report.summary.otherKnown],
              ["Не установлено", report.summary.unknown],
              ["Неверный формат", report.summary.invalid],
            ].map(([label, value]) => (
              <div className="panel p-4" key={label}>
                <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
                <p className="mt-2 text-2xl font-semibold text-zinc-100">{value}</p>
              </div>
            ))}
          </section>

          <section className="panel overflow-hidden">
            <div className="border-b border-sentinel-line p-4">
              <h3 className="font-semibold text-zinc-100">Результаты проверки</h3>
              <p className="mt-1 text-xs text-zinc-500">Источник сопоставления: {report.provider}. Сформировано {new Date(report.generatedAt).toLocaleString("ru-RU")}.</p>
              {report.providerStatus?.length ? (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {report.providerStatus.map((provider) => (
                    <span className={`rounded border px-2 py-1 ${provider.checked ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-300" : "border-amber-400/30 bg-amber-400/5 text-amber-300"}`} key={provider.name} title={provider.message || ""}>
                      {provider.name}: {provider.checked ? "проверено" : provider.configured ? "ошибка проверки" : "нужен свой ключ"}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="border-b border-sentinel-line text-xs text-zinc-500">
                  <tr>
                    <th className="p-3">Адрес</th>
                    <th className="p-3">Сеть</th>
                    <th className="p-3">Вывод</th>
                    <th className="p-3">Организация</th>
                    <th className="p-3">Тип</th>
                    <th className="p-3">Уверенность</th>
                    <th className="p-3">Источник</th>
                    <th className="p-3">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.map((item) => (
                    <tr className="border-b border-sentinel-line/70 align-top" key={item.address}>
                      <td className="p-3 font-mono text-xs text-zinc-200" title={item.address}>{shortAddress(item.address)}</td>
                      <td className="p-3 text-zinc-400">{item.networkKey}</td>
                      <td className="p-3">
                        <span className={`rounded border px-2 py-1 text-xs ${item.isExchange ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : item.identified ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-zinc-700 bg-zinc-900 text-zinc-400"}`}>
                          {item.isExchange ? "МЕТКА БИРЖИ НАЙДЕНА" : item.identified ? "ИЗВЕСТНЫЙ НЕБИРЖЕВОЙ АДРЕС" : item.validFormat ? "НЕ УСТАНОВЛЕНО" : "НЕВЕРНЫЙ ФОРМАТ"}
                        </span>
                      </td>
                      <td className="p-3 text-zinc-100">{item.entity?.name || "—"}</td>
                      <td className="p-3 text-zinc-400">{attributionTypeLabel(item.entity?.serviceType)}</td>
                      <td className="p-3 text-zinc-400">{item.entity ? `${item.entity.confidence}%` : "—"}</td>
                      <td className="p-3 text-xs text-zinc-500" title={item.entity?.source || ""}>
                        {item.entity?.externalUrl ? <a className="text-sky-400 hover:text-sky-300" href={item.entity.externalUrl} rel="noreferrer" target="_blank">{item.entity.source}</a> : item.entity?.source || "—"}
                        {item.attributionWarnings?.length ? <p className="mt-1 text-amber-400" title={item.attributionWarnings.join("\n")}>Публичный источник ответил не полностью</p> : null}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-2">
                          <button className="ghost-button min-h-9 px-3" onClick={() => copyAddress(item.address)} type="button">Копировать</button>
                          {item.validFormat ? <button className="ghost-button min-h-9 px-3" onClick={() => openWallet?.({ address: item.address })} type="button">Открыть</button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {copyStatus ? <p className="p-3 text-xs text-zinc-500">{copyStatus}</p> : null}
          </section>
        </>
      ) : null}

      <section className="panel p-4">
        <p className="section-label">РУЧНАЯ ПОДТВЕРЖДЁННАЯ МЕТКА</p>
        <h3 className="mt-1 font-semibold text-zinc-100">Добавить известный адрес биржи</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          Используйте только проверяемый источник: официальный ответ биржи, судебный документ, официальную публикацию либо лицензированный набор меток.
        </p>
        <form className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={saveManualExchange}>
          <input className="control min-h-11" placeholder="Адрес кошелька" value={manual.address} onChange={(event) => setManual({ ...manual, address: event.target.value })} />
          <input className="control min-h-11" placeholder="Название биржи" value={manual.name} onChange={(event) => setManual({ ...manual, name: event.target.value })} />
          <select className="control min-h-11" value={manual.networkKey} onChange={(event) => setManual({ ...manual, networkKey: event.target.value })}>
            <option value="TRX">TRON</option><option value="ETH">Ethereum / EVM</option><option value="BTC">Bitcoin</option>
          </select>
          <input className="control min-h-11" placeholder="Источник / номер документа" required value={manual.source} onChange={(event) => setManual({ ...manual, source: event.target.value })} />
          <input className="control min-h-11" max="100" min="1" type="number" value={manual.confidence} onChange={(event) => setManual({ ...manual, confidence: event.target.value })} />
          <input className="control min-h-11" placeholder="Примечание" value={manual.notes} onChange={(event) => setManual({ ...manual, notes: event.target.value })} />
          <button className="primary-button min-h-11 md:col-span-2 xl:col-span-3" disabled={loading} type="submit">Сохранить подтверждённую метку</button>
        </form>
      </section>
    </div>
  );
}

function SanctionsDatabasePage({ addFeed, openWallet }) {
  const [labels, setLabels] = useState([]);
  const [query, setQuery] = useState("");
  const [networkFilter, setNetworkFilter] = useState("ALL");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  const refresh = async () => {
    setError("");
    setLoading(true);

    try {
      setLabels(await listEntityLabels());
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const riskLabels = useMemo(
    () => labels.filter(isRiskDatabaseLabel).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    [labels]
  );
  const sanctionsLabels = useMemo(() => riskLabels.filter(isSanctionsEntityLabel), [riskLabels]);
  const scamLabels = useMemo(() => riskLabels.filter((label) => String(label.category || "").toLowerCase() === "scam"), [riskLabels]);
  const benignLabels = useMemo(() => riskLabels.filter((label) => String(label.category || "").toLowerCase() === "benign"), [riskLabels]);
  const sourceCount = useMemo(() => uniqueValuesClient(riskLabels.map((label) => label.source || "manual")).length, [riskLabels]);
  const networkOptions = useMemo(
    () => ["ALL", ...uniqueValuesClient(riskLabels.map((label) => label.networkKey || "UNKNOWN")).sort()],
    [riskLabels]
  );
  const latestUpdate = useMemo(() => {
    const timestamps = riskLabels.map((label) => Date.parse(label.updatedAt || label.createdAt || "")).filter(Number.isFinite);
    return timestamps.length ? new Date(Math.max(...timestamps)).toLocaleString("ru-RU") : "нет данных";
  }, [riskLabels]);
  const filteredLabels = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return riskLabels.filter((label) => {
      const category = String(label.category || "").toLowerCase();
      const matchesNetwork = networkFilter === "ALL" || label.networkKey === networkFilter;
      const matchesCategory = categoryFilter === "all" || category === categoryFilter || (categoryFilter === "sanctions" && isSanctionsEntityLabel(label));
      const matchesSource = sourceFilter === "all" || entitySourceGroup(label) === sourceFilter;
      const searchable = [
        label.address,
        label.name,
        label.networkKey,
        label.source,
        entitySourceLabel(label),
        label.notes,
        label.category,
      ].filter(Boolean).join(" ").toLowerCase();

      return matchesNetwork && matchesCategory && matchesSource && (!needle || searchable.includes(needle));
    });
  }, [categoryFilter, networkFilter, query, riskLabels, sourceFilter]);

  const importOfac = async () => {
    setLoading(true);
    setError("");

    try {
      const result = await importOfacEntityLabels();
      await refresh();
      addFeed(`OFAC sanctions: импортировано ${result.imported}, пропущено ${result.skipped}`);
    } catch (importError) {
      setError(importError.message);
    } finally {
      setLoading(false);
    }
  };

  const copyAddress = async (item) => {
    try {
      await navigator.clipboard.writeText(item.address);
      setCopyStatus(`${shortAddress(item.address)} copied`);
    } catch {
      setCopyStatus("copy failed");
    }
  };

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label">Risk address database</p>
            <h2 className="mt-1 text-xl font-semibold text-zinc-100">Risk labels: sanctions + scam</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500">
              Local address intelligence database: OFAC sanctions, Poison-Hunter phishing/scam addresses, FBI DPRK stolen funds, Etherscan benign labels and manual labels. Every row shows its source.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ghost-button min-h-10" disabled={loading} onClick={refresh} type="button">
              Обновить
            </button>
            <button className={`primary-button min-h-10 ${loading ? "button-loading" : ""}`} disabled={loading} onClick={importOfac} type="button">
              {loading ? <LoadingDots label="OFAC" /> : "Загрузить OFAC"}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-5">
          {[
            ["Risk labels", riskLabels.length.toLocaleString("ru-RU")],
            ["Sanctions", sanctionsLabels.length.toLocaleString("ru-RU")],
            ["Scam", scamLabels.length.toLocaleString("ru-RU")],
            ["Benign", benignLabels.length.toLocaleString("ru-RU")],
            ["Sources", sourceCount.toLocaleString("ru-RU")],
          ].map(([label, value]) => (
            <div className="panel-subtle p-3" key={label}>
              <p className="text-xs text-zinc-500">{label}</p>
              <p className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.7fr_0.7fr_0.8fr_auto]">
          <input
            aria-label="Поиск по санкционным адресам"
            className="control min-h-10"
            placeholder="Поиск: адрес, entity, сеть, source, program"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select aria-label="Фильтр сети" className="control min-h-10" value={networkFilter} onChange={(event) => setNetworkFilter(event.target.value)}>
            {networkOptions.map((network) => (
              <option key={network} value={network}>{network === "ALL" ? "Все сети" : network}</option>
            ))}
          </select>
          <select aria-label="Category filter" className="control min-h-10" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="all">All categories</option>
            <option value="sanctions">sanctions</option>
            <option value="scam">scam</option>
            <option value="benign">benign</option>
          </select>
          <select aria-label="Фильтр источника" className="control min-h-10" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
            <option value="all">All sources</option>
            <option value="ofac">OFAC SLS</option>
            <option value="poison">Poison-Hunter</option>
            <option value="etherscan">Etherscan benign</option>
            <option value="fbi">FBI</option>
            <option value="manual">Manual / other</option>
          </select>
          <button className="ghost-button min-h-10" onClick={() => { setQuery(""); setNetworkFilter("ALL"); setCategoryFilter("all"); setSourceFilter("all"); }} type="button">
            Сброс
          </button>
        </div>
        <p className="mt-3 text-xs text-zinc-600">Last update: {latestUpdate}</p>

        {error ? (
          <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">
            {error}
          </div>
        ) : null}
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="section-label">Address list</p>
            <h3 className="mt-1 text-lg font-semibold text-zinc-100">
              Found {filteredLabels.length.toLocaleString("ru-RU")} of {riskLabels.length.toLocaleString("ru-RU")}
            </h3>
          </div>
          {copyStatus ? <span className="rounded border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-500">{copyStatus}</span> : null}
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="py-3 pr-3 font-medium">Адрес</th>
                <th className="py-3 pr-3 font-medium">Сеть</th>
                <th className="py-3 pr-3 font-medium">Category</th>
                <th className="py-3 pr-3 font-medium">Entity / описание</th>
                <th className="py-3 pr-3 font-medium">Source</th>
                <th className="py-3 pr-3 font-medium">Обновлено</th>
                <th className="py-3 pr-3 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredLabels.slice(0, 300).map((label) => (
                <tr className="border-b border-zinc-900 last:border-b-0" key={label.id}>
                  <td className="py-3 pr-3">
                    <p className="break-all font-semibold text-zinc-200">{label.address}</p>
                    <p className="mt-1 text-xs text-zinc-600">confidence {label.confidence || 100}%</p>
                  </td>
                  <td className="py-3 pr-3">
                    <span className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-400">{label.networkKey || "UNKNOWN"}</span>
                  </td>
                  <td className="py-3 pr-3">
                    <span className={`rounded border px-2 py-1 text-xs ${
                      isSanctionsEntityLabel(label)
                        ? "border-sentinel-danger/40 bg-sentinel-danger/10 text-sentinel-danger"
                        : String(label.category || "").toLowerCase() === "benign"
                          ? "border-sentinel-green/35 bg-sentinel-green/10 text-sentinel-green"
                          : "border-sentinel-warning/40 bg-sentinel-warning/10 text-sentinel-warning"
                    }`}>
                      {isSanctionsEntityLabel(label) ? "sanctions" : label.category || "entity"}
                    </span>
                  </td>
                  <td className="py-3 pr-3">
                    <p className="font-medium text-zinc-200">{label.name || "Risk address"}</p>
                    <p className="mt-1 max-w-[420px] text-xs leading-5 text-zinc-500">{label.notes || "Local risk entity label"}</p>
                  </td>
                  <td className="py-3 pr-3">
                    <p className="max-w-[260px] break-words text-xs font-semibold text-zinc-300">{entitySourceLabel(label)}</p>
                    <p className="mt-1 max-w-[260px] break-words text-[11px] text-zinc-600">{label.source || "manual"}</p>
                  </td>
                  <td className="py-3 pr-3 text-zinc-500">
                    {label.updatedAt ? new Date(label.updatedAt).toLocaleString("ru-RU") : "unknown"}
                  </td>
                  <td className="py-3 pr-3">
                    <div className="flex flex-wrap gap-2">
                      <button className="ghost-button min-h-8" onClick={() => copyAddress(label)} type="button">
                        Copy
                      </button>
                      <button className="ghost-button min-h-8" onClick={() => openWallet?.({ address: label.address })} type="button">
                        Открыть
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredLabels.length ? (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-6 text-sm leading-6 text-zinc-500">
              No matches for the current filters. Reset search or choose another source/category.
            </div>
          ) : null}
          {filteredLabels.length > 300 ? (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-black p-3 text-xs text-zinc-500">
              Показаны первые 300 совпадений. Уточните поиск или фильтр сети для более точной выборки.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EntityLabelsPanel({ addFeed }) {
  const [labels, setLabels] = useState([]);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("mixer");
  const [networkKey, setNetworkKey] = useState("ETH");
  const [confidence, setConfidence] = useState("85");
  const [bulkText, setBulkText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setError("");
    try {
      const result = await listEntityLabels();
      setLabels(result);
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const label = await upsertEntityLabel({
        address,
        name,
        category,
        networkKey,
        confidence,
        source: "manual",
      });
      setLabels((current) => [label, ...current.filter((item) => item.id !== label.id)]);
      setAddress("");
      setName("");
      addFeed(`${label.address}: добавлена метка ${label.category}`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setLoading(false);
    }
  };

  const importBulk = async () => {
    if (!bulkText.trim()) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result = await importCsvEntityLabels(bulkText);
      setBulkText("");
      await refresh();
      addFeed(`CSV labels: импортировано ${result.imported}, пропущено ${result.skipped}`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setLoading(false);
    }
  };

  const importOfac = async () => {
    setLoading(true);
    setError("");

    try {
      const result = await importOfacEntityLabels();
      await refresh();
      addFeed(`OFAC sanctions: импортировано ${result.imported}, пропущено ${result.skipped}`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setLoading(false);
    }
  };

  const removeLabel = async (label) => {
    setError("");
    try {
      await deleteEntityLabel(label.id);
      setLabels((current) => current.filter((item) => item.id !== label.id));
      addFeed(`${label.address}: метка удалена`);
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Entity labels</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">База адресов</h2>
        </div>
        <span className="rounded border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-500">
          {labels.length}
        </span>
      </div>

      <form className="mt-4 grid gap-2" onSubmit={submit}>
        <input aria-label="Адрес сервиса" className="control min-h-10" placeholder="Адрес сервиса" value={address} onChange={(event) => setAddress(event.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select aria-label="Категория метки" className="control min-h-10" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="mixer">mixer</option>
            <option value="bridge">bridge</option>
            <option value="exchange">exchange</option>
            <option value="scam">scam</option>
            <option value="sanctions">sanctions</option>
            <option value="service">service</option>
          </select>
          <input aria-label="Сеть метки" className="control min-h-10" placeholder="ETH/TRX/ALL" value={networkKey} onChange={(event) => setNetworkKey(event.target.value)} />
        </div>
        <input aria-label="Название" className="control min-h-10" placeholder="Название" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="grid grid-cols-[minmax(0,1fr)_108px] gap-2">
          <input aria-label="Confidence" className="control min-h-10" placeholder="Confidence" value={confidence} onChange={(event) => setConfidence(event.target.value)} />
          <button className="primary-button min-h-10" disabled={loading} type="submit">
            Добавить
          </button>
        </div>
      </form>

      <div className="mt-4 grid gap-2">
        <textarea
          aria-label="CSV import"
          className="control min-h-24 resize-none py-3"
          placeholder="CSV: address, category, name, network, confidence, source, notes"
          value={bulkText}
          onChange={(event) => setBulkText(event.target.value)}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <button className="ghost-button min-h-10" disabled={loading} onClick={importBulk} type="button">
            Импортировать список
          </button>
          <button className="ghost-button min-h-10" disabled={loading} onClick={importOfac} type="button">
            Загрузить OFAC
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-xs text-sentinel-danger">
          {error}
        </div>
      ) : null}

      <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto pr-1">
        {labels.slice(0, 30).map((label) => (
          <div className="rounded-md border border-zinc-800 bg-black p-3" key={label.id}>
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-semibold text-zinc-200">{label.name}</p>
              <span className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">{label.category}</span>
            </div>
            <p className="mt-2 break-all text-xs text-zinc-500">{label.address}</p>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-600">
              <span>{label.networkKey} · {label.confidence}%</span>
              <button className="text-sentinel-danger hover:text-red-300" onClick={() => removeLabel(label)} type="button">
                удалить
              </button>
            </div>
          </div>
        ))}
        {!labels.length ? (
          <div className="rounded-lg border border-zinc-800 bg-black p-4 text-sm leading-6 text-zinc-500">
            Меток пока нет. Добавьте адрес миксера, bridge или биржи, затем запустите анализ.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MixerRulesPanel() {
  const rules = [
    ["Known mixer label", "адрес транзакции совпал с локальной базой mixer/privacy адресов", "strong"],
    ["Mixer -> exchange", "после known mixer входа найден депозит на CEX", "strong"],
    ["Bridge -> exchange", "bridge-flow показывается отдельно и не считается mixer evidence", "medium"],
    ["Structured flow", "одинаковые суммы, fresh wallets или pool-like fan-in/fan-out без mixer label", "weak"],
    ["Exit candidate", "добавляется только при строгом контексте: known mixer или сильная flow-связь", "watch"],
  ];

  return (
    <section className="panel p-4">
      <p className="section-label">Detection logic</p>
      <h2 className="mt-1 text-lg font-semibold text-zinc-100">Правила без догадок</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-500">
        Система не называет адрес миксером только по похожим суммам. Сильный mixer-сигнал появляется при прямом совпадении
        с локальной базой известных mixer/privacy адресов; остальные паттерны остаются структурными признаками.
      </p>

      <div className="mt-4 grid gap-3">
        {rules.map(([name, description, weight]) => (
          <div className="panel-subtle grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_64px]" key={name}>
            <div>
              <p className="text-sm font-semibold text-zinc-200">{name}</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
            </div>
            <div className="grid place-items-center rounded-md border border-zinc-800 bg-black text-sm font-semibold text-zinc-300">
              {weight}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InvestigationsPanel({ activeWorkspaceId, activeWorkspaceName, openInvestigationCase }) {
  const [cases, setCases] = useState([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ title: "", rootAddress: "", victimReference: "", lossAmount: "", asset: "USDT", notes: "" });

  const refreshCases = async () => {
    setError("");
    try {
      setCases(await listInvestigationCases(activeWorkspaceId));
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => {
    refreshCases();
  }, [activeWorkspaceId]);

  const removeCase = async (item) => {
    setError("");
    try {
      await deleteInvestigationCase(item.id);
      setCases((current) => current.filter((caseItem) => caseItem.id !== item.id));
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const createManualCase = async (event) => {
    event.preventDefault();
    const rootAddress = draft.rootAddress.trim();

    if (!rootAddress) {
      setError("Укажите исходный адрес или адрес получателя средств.");
      return;
    }

    setError("");
    try {
      const savedCase = await upsertInvestigationCase({
        profileId: activeWorkspaceId,
        title: draft.title.trim() || `Дело ${shortAddress(rootAddress)} · ${new Date().toLocaleDateString("ru-RU")}`,
        rootAddress,
        networkKey: detectNetwork(rootAddress),
        severity: "Medium",
        status: "open",
        summary: { source: "manual_intake", evidenceRecords: 0 },
        victims: draft.victimReference.trim() ? [{ reference: draft.victimReference.trim() }] : [],
        loss: draft.lossAmount.trim() ? { amount: draft.lossAmount.trim(), asset: draft.asset } : null,
        notes: draft.notes.trim(),
        evidence: [],
      }, activeWorkspaceId);
      setCases((current) => [savedCase, ...current.filter((item) => item.id !== savedCase.id)]);
      setDraft({ title: "", rootAddress: "", victimReference: "", lossAmount: "", asset: "USDT", notes: "" });
    } catch (createError) {
      setError(createError.message);
    }
  };

  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-label">Investigations</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Расследования</h2>
          <p className="mt-1 text-xs text-zinc-500">Профиль: {activeWorkspaceName}</p>
        </div>
        <button className="ghost-button min-h-10" onClick={refreshCases} type="button">
          Обновить
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">
          {error}
        </div>
      ) : null}

      <form className="mt-4 grid gap-3 rounded-lg border border-zinc-800 bg-black p-4" onSubmit={createManualCase}>
        <div>
          <p className="text-sm font-semibold text-zinc-200">Зарегистрировать новое дело</p>
          <p className="mt-1 text-xs text-zinc-600">Все сведения сохраняются в локальном рабочем пространстве пользователя.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <input className="control min-h-10" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Название или номер дела" value={draft.title} />
          <input className="control min-h-10 font-mono" onChange={(event) => setDraft((current) => ({ ...current, rootAddress: event.target.value }))} placeholder="Исходный адрес / адрес получателя" value={draft.rootAddress} />
          <input className="control min-h-10" onChange={(event) => setDraft((current) => ({ ...current, victimReference: event.target.value }))} placeholder="Потерпевший или внутренний номер эпизода" value={draft.victimReference} />
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
            <input className="control min-h-10" inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, lossAmount: event.target.value }))} placeholder="Сумма ущерба" value={draft.lossAmount} />
            <select className="control min-h-10" onChange={(event) => setDraft((current) => ({ ...current, asset: event.target.value }))} value={draft.asset}>
              <option value="USDT">USDT</option>
              <option value="USDC">USDC</option>
              <option value="TRX">TRX</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
            </select>
          </div>
        </div>
        <textarea className="control min-h-24 p-3" onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Краткие обстоятельства, известные телефоны, банковские операции и другие примечания" value={draft.notes} />
        <div><button className="primary-button min-h-10 px-4" type="submit">Создать дело</button></div>
      </form>

      <div className="mt-4 grid gap-3">
        {cases.map((item) => (
          <article className="panel-subtle grid gap-3 p-3 sm:grid-cols-[120px_minmax(0,1fr)_96px_156px]" key={item.id}>
            <p className="text-sm font-semibold text-zinc-300">{item.id.slice(0, 12)}</p>
            <div>
              <p className="text-sm font-semibold text-zinc-100">{item.title}</p>
              <p className="mt-1 break-all text-xs text-zinc-500">{item.rootAddress}</p>
              {item.summary?.reportId ? (
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  {item.networkKey} · отчёт {item.summary.reportId} · переводов {item.summary.tracedSteps || 0} · получателей {item.summary.directRecipients || 0} · точек сбора {item.summary.convergenceCount || 0} · точек выхода {item.summary.exitPointCount || 0} · покрытие {Number(item.summary.tracedCoveragePercent || 0).toFixed(2)}%
                </p>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">
                  {item.networkKey} · {item.summary?.visibleNodes ?? item.summary?.nodes ?? 0}/{item.summary?.nodes || 0} nodes · {item.summary?.visibleEdges ?? item.summary?.edges ?? 0}/{item.summary?.edges || 0} edges · {item.summary?.pathHops || 0} hops
                </p>
              )}
              <p className="mt-1 text-xs text-zinc-600">
                evidence {item.evidence?.length || 0} · SHA-256 {item.summary?.reportSha256 ? `${item.summary.reportSha256.slice(0, 12)}…` : "нет"} · updated {item.updatedAt ? new Date(item.updatedAt).toLocaleString("ru-RU") : "unknown"}
              </p>
              {item.summary?.visibleEdgeCategoryCounts ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(item.summary.visibleEdgeCategoryCounts).slice(0, 6).map(([category, count]) => (
                    <span className="rounded border border-zinc-800 bg-black px-2 py-1 text-[11px] text-zinc-500" key={category}>
                      {category}: {count}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <span
              className={`grid h-8 place-items-center rounded-md border text-xs ${
                item.severity === "High"
                  ? "border-sentinel-danger/50 text-sentinel-danger"
                  : "border-sentinel-warning/50 text-sentinel-warning"
              }`}
            >
              {item.severity}
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button className="ghost-button min-h-8" onClick={() => openInvestigationCase(item)} type="button">
                Открыть
              </button>
              <button className="ghost-button min-h-8 text-sentinel-danger" onClick={() => removeCase(item)} type="button">
                Удалить
              </button>
            </div>
          </article>
        ))}
        {!cases.length ? (
          <div className="rounded-lg border border-zinc-800 bg-black p-6 text-sm leading-6 text-zinc-500">
            Сохраненных кейсов пока нет. Постройте граф и нажмите «Сохранить кейс».
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AuditLogPanel() {
  const [events, setEvents] = useState([]);
  const [integrity, setIntegrity] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");

    try {
      const result = await listAuditEvents(200);
      setEvents(result.items || []);
      setIntegrity(result.integrity || "");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="section-label">Audit Log</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Журнал действий</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Ручные изменения дел, меток и watchlist. Целостность: {integrity === "sha256_hash_chain" ? "цепочка SHA-256" : "не определена"}.
          </p>
        </div>
        <button className="ghost-button min-h-10" disabled={loading} onClick={refresh} type="button">
          {loading ? <LoadingDots label="Загрузка" /> : "Обновить"}
        </button>
      </div>

      {error ? <div className="mt-4 rounded-lg border border-sentinel-danger/40 bg-sentinel-danger/10 p-3 text-sm text-sentinel-danger">{error}</div> : null}

      <div className="mt-4 grid gap-2">
        {events.map((event) => (
          <article className="grid gap-2 rounded-lg border border-zinc-800 bg-black p-3 lg:grid-cols-[170px_180px_minmax(0,1fr)_170px]" key={event.id}>
            <div>
              <p className="text-xs font-semibold text-zinc-200">{event.action}</p>
              <p className="mt-1 text-[11px] text-zinc-600">{event.entityType}</p>
            </div>
            <div>
              <p className="break-all font-mono text-xs text-zinc-400">{event.entityId || "—"}</p>
              <p className="mt-1 text-[11px] text-zinc-600">{event.actorUsername || event.actorId}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">{event.reason || "Изменение зафиксировано без отдельного основания."}</p>
              <p className="mt-1 break-all font-mono text-[10px] text-zinc-700">SHA-256 {event.eventHash}</p>
            </div>
            <p className="text-xs text-zinc-500">{event.createdAt ? new Date(event.createdAt).toLocaleString("ru-RU") : "—"}</p>
          </article>
        ))}
        {!loading && !events.length ? (
          <div className="rounded-lg border border-zinc-800 bg-black p-6 text-sm leading-6 text-zinc-500">
            Журнал пока пуст. Новые изменения дел, меток и watchlist будут фиксироваться после этого обновления.
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default App;
