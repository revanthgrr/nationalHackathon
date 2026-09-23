import { useState, useRef, useEffect } from 'react';

// TODO: wire to real backend chat endpoint once available
// This is currently a mock UI-only assistant for live demos.

interface Message {
  id: string;
  sender: 'bot' | 'user';
  text: string;
  timestamp: string;
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'msg-welcome',
    sender: 'bot',
    text: "Hi, I'm your RailSetu assistant. Ask me about live delays, block schedules, or risk alerts.",
    timestamp: 'Just now',
  },
];

const SUGGESTED_PROMPTS = [
  'Show critical defects',
  "Explain today's optimization score",
  'Any active disruptions?',
];

function getMockResponse(query: string): string {
  const q = query.toLowerCase();

  if (q.includes('delay') || q.includes('late') || q.includes('punctual')) {
    return '⏱️ GCN-LSTM delay model forecast: Kazipet–Secunderabad corridor average delay is 8.2 mins. Primary bottleneck: Moula Ali junction (+14 min delay buffer). Express trains 12723 and 17015 are running on priority paths.';
  }

  if (q.includes('defect') || q.includes('fracture') || q.includes('track issue') || q.includes('wear')) {
    return '⚠️ Defect Registry: 4 critical defects logged on Secunderabad Division: 2 Civil rail stress alerts (KM 142/6-8), 1 TRD cantilever sag at Ghatkesar, and 1 S&T point machine clearance warning at Moula Ali. Maintenance sanction recommended within 48h.';
  }

  if (q.includes('risk') || q.includes('xgboost') || q.includes('fail')) {
    return '🛡️ 14-Day Risk Assessment: XGBoost failure probability for Section SC-KZJ stands at 18.4% (Nominal). High-stress zone detected around Cherlapalli outer curve due to recent gross million tonnage (GMT) cumulative load.';
  }

  if (q.includes('optimization') || q.includes('score') || q.includes('efficiency')) {
    return "📈 Today's Optimization Efficiency is 94.2%. RailSetu harmonized 6 departmental maintenance blocks across Civil & TRD with zero passenger train cancellations and only 1 freight deflection to the loop line.";
  }

  if (q.includes('disrupt') || q.includes('incident') || q.includes('emergency')) {
    return '🚨 Active Disruption Report: 1 minor signal track circuit glitch flagged near Ghatkesar (Track 2). The rolling-horizon engine has automatically scheduled a 15-minute buffer adjustment for following rakes.';
  }

  if (q.includes('schedule') || q.includes('block') || q.includes('window')) {
    return '📅 Upcoming Sanctioned Window: Civil & TRD joint maintenance block approved for 14:30–16:00 IST on Cherlapalli–Ghatkesar Down line (90 mins). Notice served to Section Controller console.';
  }

  if (q.includes('hello') || q.includes('hi') || q.includes('hey')) {
    return 'Hello! I am monitoring the Secunderabad division operational telemetry. How can I assist your corridor coordination today?';
  }

  return "I can assist with live delays, track defects, corridor risk scores, scheduled blocks, and disruptions. Try asking: 'Show critical defects', 'Explain today's optimization score', or 'Any active disruptions?'";
}

export function ChatbotWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      // Auto-focus input on open
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages, isTyping]);

  const handleSend = (textToSend?: string) => {
    const text = (textToSend ?? inputValue).trim();
    if (!text || isTyping) return;

    const userMsg: Message = {
      id: `usr-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');
    setShowSuggestions(false);
    setIsTyping(true);

    // Mock bot reply delay: 700ms typing delay
    setTimeout(() => {
      const botReply: Message = {
        id: `bot-${Date.now()}`,
        sender: 'bot',
        text: getMockResponse(text),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev.slice(-30), botReply]); // keep last 30 messages
      setIsTyping(false);
    }, 750);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {/* ── Chat Panel ── */}
      <div
        className={`fixed z-50 transition-all duration-300 ease-out flex flex-col bg-white border border-slate-200 shadow-2xl rounded-2xl overflow-hidden
          ${
            isOpen
              ? 'opacity-100 scale-100 pointer-events-auto translate-y-0'
              : 'opacity-0 scale-95 pointer-events-none translate-y-4'
          }
          /* Desktop placement: fixed bottom-24 right-6 */
          bottom-20 right-4 sm:bottom-24 sm:right-6
          w-[calc(100vw-2rem)] sm:w-[390px]
          h-[520px] max-h-[80vh]
        `}
        role="dialog"
        aria-label="RailSetu Assistant Chat"
        aria-hidden={!isOpen}
      >
        {/* Header */}
        <div className="h-16 px-4 bg-white border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Bot Avatar */}
            <div className="w-9 h-9 rounded-full bg-blue-800 text-white flex items-center justify-center shadow-xs flex-shrink-0">
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                <path d="M5 3v4" />
                <path d="M19 17v4" />
                <path d="M3 5h4" />
                <path d="M17 19h4" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900 leading-tight">
                RailSetu Assistant
              </div>
              <div className="text-[11px] font-medium text-slate-500 flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>AI-powered support</span>
              </div>
            </div>
          </div>

          {/* Close Button */}
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            aria-label="Close assistant"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Message Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/70">
          {messages.map((msg) => {
            const isBot = msg.sender === 'bot';
            return (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${isBot ? 'items-start' : 'items-end justify-end'}`}
              >
                {/* Bot Avatar Bubble */}
                {isBot && (
                  <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-800 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                    🤖
                  </div>
                )}

                <div className={`flex flex-col ${isBot ? 'items-start' : 'items-end'} max-w-[82%]`}>
                  <div
                    className={`px-3.5 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed shadow-xs ${
                      isBot
                        ? 'bg-white text-slate-800 rounded-tl-sm border border-slate-200/80'
                        : 'bg-blue-800 text-white rounded-tr-sm'
                    }`}
                  >
                    {msg.text}
                  </div>
                  {msg.timestamp && (
                    <span className="text-[10px] text-slate-400 mt-1 px-1">
                      {msg.timestamp}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Typing Indicator */}
          {isTyping && (
            <div className="flex gap-2.5 items-start">
              <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-800 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                🤖
              </div>
              <div className="bg-white border border-slate-200/80 px-4 py-3 rounded-2xl rounded-tl-sm shadow-xs flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '300ms' }}></span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggested Prompt Chips (Optional first-time help) */}
        {showSuggestions && (
          <div className="px-3 py-2 bg-slate-50 border-t border-slate-100 flex flex-wrap gap-1.5">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => handleSend(prompt)}
                className="text-[11px] font-medium bg-white hover:bg-blue-50 text-blue-900 border border-slate-200 hover:border-blue-300 rounded-full px-2.5 py-1 transition-all duration-150 shadow-2xs text-left"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {/* Input Area */}
        <div className="p-3 bg-white border-t border-slate-200 flex-shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-center gap-2"
          >
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask RailSetu Assistant..."
              className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-xs sm:text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-800 focus:bg-white transition-colors"
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || isTyping}
              className="p-2.5 rounded-xl bg-blue-800 text-white hover:bg-blue-900 active:bg-blue-950 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors shadow-xs flex-shrink-0"
              aria-label="Send message"
            >
              <svg
                className="w-4 h-4 transform rotate-90"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </form>
        </div>
      </div>

      {/* ── Floating Trigger Button ── */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-blue-800 hover:bg-blue-900 active:bg-blue-950 text-white shadow-xl hover:shadow-2xl flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 group focus:outline-none focus:ring-4 focus:ring-blue-800/30"
        aria-label={isOpen ? 'Close RailSetu Assistant' : 'Open RailSetu Assistant'}
        aria-expanded={isOpen}
      >
        {/* Pulsing Dot Badge to suggest "Assistant Available" */}
        <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500 border-2 border-white"></span>
        </span>

        {/* Icon toggle: Sparkle/Chat when closed, Cross when open */}
        {isOpen ? (
          <svg
            className="w-6 h-6 transition-transform duration-200 rotate-90 group-hover:rotate-180"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg
            className="w-6 h-6 transition-transform duration-200 group-hover:rotate-12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
            <path d="M5 3v4" />
            <path d="M19 17v4" />
            <path d="M3 5h4" />
            <path d="M17 19h4" />
          </svg>
        )}
      </button>
    </>
  );
}
