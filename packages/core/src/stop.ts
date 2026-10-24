import type { Language } from "./types";

/**
 * STOP: an opted-in resident texts one word to leave the shutoff-warning list.
 * Only a message that is nothing but the keyword counts, so "please stop by the pharmacy"
 * or "I need to end this heat" is never read as an opt-out. The standard carrier keywords
 * work, plus a few Spanish and Vietnamese ones.
 */

const KEYWORDS: Record<string, Language> = {
  stop: "en",
  stopall: "en",
  unsubscribe: "en",
  cancel: "en",
  end: "en",
  quit: "en",
  parar: "es",
  detener: "es",
  cancelar: "es",
  dung: "vi",
  "dừng": "vi",
};

/** The language of the keyword if the whole message is a stop request, otherwise null. */
export function stopRequestLanguage(text: string): Language | null {
  const word = text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s.!¡]+$/u, "")
    .replace(/^[\s¡]+/u, "");
  return Object.hasOwn(KEYWORDS, word) ? KEYWORDS[word]! : null;
}

export function isStopRequest(text: string): boolean {
  return stopRequestLanguage(text) !== null;
}

const STOP_REPLY: Record<Language, string> = {
  en: "You're unsubscribed from EVER shutoff warnings. You won't get any more. You can still text me anytime if you need help finding an open place.",
  es: "Se canceló su suscripción a los avisos de corte de luz de EVER. No recibirá más. Puede escribirme cuando necesite ayuda para encontrar un lugar abierto.",
  vi: "Bạn đã hủy nhận cảnh báo cắt điện của EVER. Bạn sẽ không nhận thêm. Bạn vẫn có thể nhắn tin cho tôi bất cứ lúc nào khi cần tìm nơi đang mở cửa.",
};

export function stopReplyText(language: Language = "en"): string {
  return STOP_REPLY[language];
}
