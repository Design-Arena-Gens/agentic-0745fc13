"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import clsx from "clsx";
import debounce from "lodash.debounce";
import { v4 as uuid } from "uuid";
import styles from "./ChatApp.module.css";
import type { ChatMessage, ChatSession } from "./types";

const STORAGE_KEY = "chatgpt-local-sessions-v1";
const ACTIVE_SESSION_KEY = "chatgpt-local-active-session";
const EMOJIS: { symbol: string; label: string }[] = [
  { symbol: "😊", label: "Smiling face" },
  { symbol: "😂", label: "Laughing tears" },
  { symbol: "❤️", label: "Red heart" },
  { symbol: "👍", label: "Thumbs up" },
  { symbol: "🤔", label: "Thinking face" },
  { symbol: "😎", label: "Cool face" },
  { symbol: "🎉", label: "Party popper" }
];

const MAX_SESSION_HISTORY = 75;
const TYPING_DELAY_MS = 1000;

const isQuotaError = (error: unknown) => {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
};

const formatTimestamp = (iso: string) => {
  const formatter = new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  });
  return formatter.format(new Date(iso));
};

const formatRelativeTimestamp = (iso: string) => {
  const now = Date.now();
  const timestamp = new Date(iso).getTime();
  const diff = now - timestamp;

  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? "s" : ""} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric"
  }).format(new Date(iso));
};

const deriveTitle = (messages: ChatMessage[]) => {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return "New chat";
  }
  const trimmed = firstUser.content.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 45) {
    return trimmed;
  }
  return `${trimmed.slice(0, 45)}…`;
};

const createEmptySession = (): ChatSession => {
  const timestamp = new Date().toISOString();
  return {
    id: uuid(),
    title: "New chat",
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

const simulateAssistantResponse = (prompt: string) => {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "I'm ready whenever you are!";
  }

  return [
    `Here's a quick reflection on your last message:`,
    `> ${trimmed}`,
    "",
    "This demo mirrors the ChatGPT interface with fully local chat history. Feel free to keep exploring or start a new conversation!"
  ].join("\n");
};

const sanitizeSessions = (sessions: ChatSession[]): ChatSession[] => {
  return sessions
    .filter((session) => session && session.id && Array.isArray(session.messages))
    .map((session) => ({
      ...session,
      title: session.title || deriveTitle(session.messages),
      createdAt: session.createdAt || new Date().toISOString(),
      updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
      messages: session.messages
        .filter((message) => message && message.id && message.role && message.content !== undefined)
        .map((message) => ({
          ...message,
          createdAt: message.createdAt || new Date().toISOString()
        }))
    }));
};

const ensureCapacity = (sessions: ChatSession[]): ChatSession[] => {
  if (sessions.length <= MAX_SESSION_HISTORY) {
    return sessions;
  }
  return sessions
    .slice(-MAX_SESSION_HISTORY)
    .map((session) => ({ ...session, messages: session.messages.slice(-200) }));
};

const readFromStorage = (): ChatSession[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    return sanitizeSessions(parsed);
  } catch (error) {
    console.warn("Failed to read chat sessions from storage", error);
    return [];
  }
};

const persistToStorage = (sessions: ChatSession[]) => {
  if (typeof window === "undefined") return;
  let payload = ensureCapacity(sessions);
  while (payload.length) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return;
    } catch (error) {
      if (!isQuotaError(error)) {
        console.warn("Failed to write chat sessions", error);
        return;
      }
      payload = payload.slice(1);
    }
  }
};

const writeActiveSession = (sessionId: string | null) => {
  if (typeof window === "undefined") return;
  if (!sessionId) {
    window.localStorage.removeItem(ACTIVE_SESSION_KEY);
    return;
  }
  try {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  } catch (error) {
    console.warn("Failed to persist active session id", error);
  }
};

const readActiveSession = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_SESSION_KEY);
};

const createMessage = (role: ChatMessage["role"], content: string): ChatMessage => ({
  id: uuid(),
  role,
  content: content.trimEnd(),
  createdAt: new Date().toISOString()
});

function ChatApp() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(false);

  const debouncedPersist = useMemo(
    () => debounce((payload: ChatSession[]) => persistToStorage(payload), 250),
    []
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  const filteredSessions = useMemo(() => {
    if (!searchTerm.trim()) return sessions;
    const needle = searchTerm.toLowerCase();
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.messages.some((message) => message.content.toLowerCase().includes(needle))
    );
  }, [sessions, searchTerm]);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      writeActiveSession(sessionId);
      setIsSidebarOpen(false);
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    },
    [setActiveSessionId]
  );

  const initialiseSessions = useCallback(() => {
    const storedSessions = readFromStorage();
    if (!storedSessions.length) {
      const freshSession = createEmptySession();
      setSessions([freshSession]);
      setActiveSessionId(freshSession.id);
      writeActiveSession(freshSession.id);
      return;
    }

    setSessions(storedSessions);
    const storedActiveId = readActiveSession();
    if (storedActiveId && storedSessions.some((session) => session.id === storedActiveId)) {
      setActiveSessionId(storedActiveId);
    } else {
      const latestSession = [...storedSessions].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))[0];
      setActiveSessionId(latestSession?.id ?? storedSessions[0].id);
      writeActiveSession(latestSession?.id ?? storedSessions[0].id);
    }
  }, []);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    initialiseSessions();
  }, [initialiseSessions]);

  useEffect(() => {
    if (!mountedRef.current) return;
    debouncedPersist(sessions);
  }, [sessions, debouncedPersist]);

  useEffect(() => () => debouncedPersist.cancel(), [debouncedPersist]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key === STORAGE_KEY) {
        const updatedSessions = readFromStorage();
        setSessions(updatedSessions);
      }
      if (event.key === ACTIVE_SESSION_KEY) {
        const newActiveId = readActiveSession();
        if (newActiveId) {
          setActiveSessionId(newActiveId);
        }
      }
    };

    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  useEffect(() => {
    autoResizeTextarea();
  }, [inputValue, autoResizeTextarea]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  const handleNewChat = useCallback(() => {
    const newSession = createEmptySession();
    setSessions((prev) => [newSession, ...prev]);
    selectSession(newSession.id);
    setInputValue("");
    setIsTyping(false);
  }, [selectSession]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const remaining = prev.filter((session) => session.id !== sessionId);
        if (!remaining.length) {
          const fallback = createEmptySession();
          setActiveSessionId(fallback.id);
          writeActiveSession(fallback.id);
          return [fallback];
        }
        if (activeSessionId === sessionId) {
          const fallbackId = remaining[0].id;
          setActiveSessionId(fallbackId);
          writeActiveSession(fallbackId);
        }
        return remaining;
      });
    },
    [activeSessionId]
  );

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== sessionId) return session;
          const nextMessages = updater(session.messages);
          return {
            ...session,
            messages: nextMessages,
            title: deriveTitle(nextMessages),
            updatedAt: new Date().toISOString()
          };
        })
      );
    },
    []
  );

  const handleSend = useCallback(() => {
    const value = inputValue.trim();
    if (!value) return;

    let sessionId = activeSessionId;
    if (!sessionId) {
      const newSession = createEmptySession();
      setSessions((prev) => [newSession, ...prev]);
      sessionId = newSession.id;
      setActiveSessionId(sessionId);
      writeActiveSession(sessionId);
    }
    const userMessage = createMessage("user", value);
    updateSessionMessages(sessionId, (messages) => [...messages, userMessage]);
    setInputValue("");
    setEmojiOpen(false);
    setIsTyping(true);

    if (textareaRef.current) {
      textareaRef.current.focus();
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      const assistantMessage = createMessage("assistant", simulateAssistantResponse(value));
      updateSessionMessages(sessionId as string, (messages) => [...messages, assistantMessage]);
      setIsTyping(false);
    }, TYPING_DELAY_MS);
  }, [inputValue, activeSessionId, updateSessionMessages, setSessions]);

  useEffect(
    () => () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;
      if (!isMeta) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setIsSidebarOpen(true);
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleNewChat();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewChat]);

  const handleTextareaKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleEmojiSelect = useCallback((emoji: string) => {
    setInputValue((prev) => `${prev}${emoji}`);
    requestAnimationFrame(autoResizeTextarea);
  }, [autoResizeTextarea]);

  const handleSidebarToggle = useCallback(() => {
    setIsSidebarOpen((prev) => !prev);
  }, []);

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.sidebarToggle}
        aria-label="Toggle chat history"
        onClick={handleSidebarToggle}
      >
        <HamburgerIcon />
      </button>
      {isSidebarOpen && (
        <div className={styles.mobileSidebarOverlay} role="dialog" aria-modal="true">
          <aside className={styles.mobileSidebar}>
            <SidebarContent
              sessions={filteredSessions}
              activeSessionId={activeSessionId}
              onSelect={selectSession}
              onDelete={handleDeleteSession}
              onNewChat={handleNewChat}
              onSearchChange={handleSearchChange}
              searchTerm={searchTerm}
              searchInputRef={searchInputRef}
            />
          </aside>
        </div>
      )}
      <aside className={styles.sidebar}>
        <SidebarContent
          sessions={filteredSessions}
          activeSessionId={activeSessionId}
          onSelect={selectSession}
          onDelete={handleDeleteSession}
          onNewChat={handleNewChat}
          onSearchChange={handleSearchChange}
          searchTerm={searchTerm}
          searchInputRef={searchInputRef}
        />
      </aside>
      <main className={styles.chatArea}>
        <button
          type="button"
          className={styles.floatingSidebarButton}
          aria-label="Open chat history"
          onClick={() => setIsSidebarOpen(true)}
        >
          <HamburgerIcon />
        </button>
        <div className={styles.chatMessages} role="log" aria-live="polite">
          {!activeSession || activeSession.messages.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>Start chatting with ChatGPT</div>
              <div className={styles.emptyText}>
                This replica keeps every conversation stored locally in your browser. Create new chats,
                revisit previous topics, and pick up right where you left off.
              </div>
            </div>
          ) : (
            activeSession.messages.map((message) => (
              <div
                key={message.id}
                className={clsx(styles.messageRow, {
                  [styles.messageRowUser]: message.role === "user",
                  [styles.messageRowAssistant]: message.role === "assistant"
                })}
              >
                <div
                  className={clsx(styles.messageBubble, {
                    [styles.userBubble]: message.role === "user",
                    [styles.assistantBubble]: message.role === "assistant"
                  })}
                >
                  {message.content}
                  <span className={styles.timestamp}>{formatTimestamp(message.createdAt)}</span>
                </div>
              </div>
            ))
          )}
          {isTyping && (
            <div className={clsx(styles.messageRow, styles.messageRowAssistant)}>
              <div className={styles.typingIndicator} aria-live="assertive" aria-label="Assistant typing">
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
              </div>
            </div>
          )}
        </div>
        <div className={styles.inputArea}>
          {emojiOpen && (
            <div className={styles.emojiPicker} role="listbox" aria-label="Emoji picker">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji.symbol}
                  type="button"
                  className={styles.emojiButton}
                  onClick={() => handleEmojiSelect(emoji.symbol)}
                  aria-label={emoji.label}
                >
                  <span role="img" aria-hidden="true">
                    {emoji.symbol}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className={styles.inputWrapper}>
            <button
              type="button"
              className={styles.controlButton}
              aria-label={emojiOpen ? "Hide emoji picker" : "Show emoji picker"}
              onClick={() => setEmojiOpen((prev) => !prev)}
            >
              <EmojiIcon />
            </button>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder="Send a message..."
              value={inputValue}
              rows={1}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              aria-label="Message input"
            />
            <button
              type="button"
              className={clsx(styles.controlButton, styles.sendButton)}
              aria-label="Send message"
              onClick={handleSend}
              disabled={!inputValue.trim()}
            >
              <SendIcon />
            </button>
          </div>
          <small className={styles.helperText}>
            Chat history lives only in your browser. Use Cmd/Ctrl + N to start fresh, Cmd/Ctrl + K to search.
          </small>
        </div>
      </main>
    </div>
  );
}

type SidebarContentProps = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onNewChat: () => void;
  onSearchChange: (value: string) => void;
  searchTerm: string;
  searchInputRef: RefObject<HTMLInputElement>;
};

const SidebarContent = ({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onNewChat,
  onSearchChange,
  searchTerm,
  searchInputRef
}: SidebarContentProps) => {
  return (
    <>
      <div className={styles.sidebarHeader}>
        <span className={styles.sidebarTitle}>Chat history</span>
        <button type="button" className={styles.newChatButton} onClick={onNewChat} aria-label="New chat">
          <PlusIcon />
        </button>
      </div>
      <div className={styles.searchWrapper}>
        <input
          ref={searchInputRef}
          type="search"
          className={styles.searchInput}
          placeholder="Search conversations"
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label="Search chat history"
        />
      </div>
      <nav className={styles.historyList} aria-label="Chat history">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={clsx(styles.historyItem, {
              [styles.historyItemActive]: session.id === activeSessionId
            })}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(session.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(session.id);
              }
            }}
          >
            <span className={styles.historyTitle}>{session.title}</span>
            <span className={styles.historyTimestamp}>{formatRelativeTimestamp(session.updatedAt)}</span>
            <button
              type="button"
              className={styles.deleteButton}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(session.id);
              }}
              aria-label="Delete chat"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </nav>
      <div className={styles.profileFooter}>
        <div className={styles.avatar} aria-hidden="true">
          JT
        </div>
        <div>
          <div style={{ fontWeight: 600 }}>Jordan Taylor</div>
          <div style={{ fontSize: "0.8rem", color: "#a1a4ac" }}>Local workspace</div>
        </div>
      </div>
    </>
  );
};

const PlusIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M10 4V16M4 10H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M5.5 6.5V12M10.5 6.5V12M3.5 4.5H12.5M6.5 2.5H9.5M4.5 4.5L5 13C5 13.5523 5.44772 14 6 14H10C10.5523 14 11 13.5523 11 13L11.5 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path
      d="M16.6931 2.17802L1.79391 7.72335C0.52603 8.20125 0.54243 9.79502 1.82121 10.2508L6.04112 11.7423L7.58371 15.8226C8.03685 16.9959 9.66593 17.0042 10.1315 15.8368L16.9978 3.55815C17.523 2.2594 17.1254 1.82535 16.6931 2.17802ZM6.70183 10.2089L14.0908 4.70043L8.10364 11.6085L6.70183 10.2089ZM9.14093 14.7766L7.94243 11.6542L9.42264 10.0301L9.14093 14.7766Z"
      fill="currentColor"
    />
  </svg>
);

const EmojiIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="M10 18C14.4183 18 18 14.4183 18 10C18 5.58172 14.4183 2 10 2C5.58172 2 2 5.58172 2 10C2 14.4183 5.58172 18 10 18Z"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M7.5 8.5C7.77614 8.5 8 8.27614 8 8C8 7.72386 7.77614 7.5 7.5 7.5C7.22386 7.5 7 7.72386 7 8C7 8.27614 7.22386 8.5 7.5 8.5Z"
      fill="currentColor"
      stroke="currentColor"
    />
    <path
      d="M12.5 8.5C12.7761 8.5 13 8.27614 13 8C13 7.72386 12.7761 7.5 12.5 7.5C12.2239 7.5 12 7.72386 12 8C12 8.27614 12.2239 8.5 12.5 8.5Z"
      fill="currentColor"
      stroke="currentColor"
    />
    <path
      d="M6.5 11.5C7.375 13 8.54167 13.75 10 13.75C11.4583 13.75 12.625 13 13.5 11.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const HamburgerIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path
      d="M4 7.5H18M4 11H18M4 14.5H18"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default ChatApp;
