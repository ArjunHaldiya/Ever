import { formatHours } from "./hours";
import type { Match } from "./matcher";
import type { Language, NeedType, ProcessingMode, Tier } from "./types";

/**
 * Reply templates. Used as-is in degraded mode and as the fallback when the
 * Bedrock reply writer fails. The short conversational strings exist in en/es/vi;
 * the full routed reply (names, bring-list, reason) is English only here, and is
 * localized by Bedrock on the AI path. The es/vi strings need a native-speaker
 * review before they go in front of judges.
 * Nothing here gives medical advice: only "go here", "bring this", "call 911".
 */

export const BACKUP_MODE_NOTICE =
  "Running in backup mode (no AI right now), so answers may be less flexible.";

type Strings = {
  askLocation: string;
  clarify: string;
  info: string;
  locationNotFound: string;
  /** {miles} is replaced with the search radius. */
  noVerified: string;
  /** {label} is replaced with the kind of place, e.g. "pharmacies". */
  nearbyIntro: string;
  confirmedFar: string;
  /** Notes shown after a listed place's distance. */
  open24h: string;
  openNow: string;
  /** What kind of places are listed, per need. */
  labels: Record<NeedType, string>;
  utilityNote: string;
  call211: string;
  emergencyLine: string;
  backupNotice: string;
};

const STRINGS: Record<Language, Strings> = {
  en: {
    askLocation: "What's your ZIP or nearest cross streets?",
    clarify:
      "Sorry, I didn't catch that. Do you need medicine, food, a cool place, or phone charging? Tell me which, and your ZIP.",
    info: "I can point you to an open pharmacy, food site, cooling center, or charging station that has power. Tell me what you need and your ZIP.",
    locationNotFound: "I couldn't find that location. Please send your 5-digit ZIP.",
    noVerified: "I don't have a confirmed open place with power within {miles} miles of you.",
    nearbyIntro: "Closest {label} listed as open right now (we can't confirm they have power, please call ahead):",
    confirmedFar: "Confirmed open with power, but farther away:",
    open24h: "open 24 hours",
    openNow: "open now",
    labels: {
      pharmacy: "pharmacies",
      refrigeration: "pharmacies",
      charging: "cafes and shops",
      cooling: "libraries, cafes and shops",
      food: "places selling food",
      device_power: "places",
      info: "places",
    },
    utilityNote:
      "If you rely on powered medical equipment, also contact your electric utility; many keep a list of customers who depend on it.",
    call211: "For help finding open resources near you, call 211. If it's an emergency, call 911.",
    emergencyLine: "If this is an emergency, call 911.",
    backupNotice: BACKUP_MODE_NOTICE,
  },
  es: {
    askLocation: "¿Cuál es su código postal o las calles cruzadas más cercanas?",
    clarify:
      "Perdón, no le entendí. ¿Necesita medicina, comida, un lugar fresco o cargar su teléfono? Dígame cuál y su código postal.",
    info: "Puedo indicarle una farmacia, un sitio de comida, un centro de enfriamiento o una estación de carga abiertos y con electricidad. Dígame qué necesita y su código postal.",
    locationNotFound: "No pude encontrar esa ubicación. Envíe su código postal de 5 dígitos.",
    noVerified: "No tengo un lugar abierto y con electricidad confirmado a menos de {miles} millas de usted.",
    nearbyIntro: "Lo más cercano ({label}) que figura abierto ahora; no podemos confirmar que tenga electricidad, llame antes de ir:",
    confirmedFar: "Confirmado abierto y con electricidad, pero más lejos:",
    open24h: "abierto las 24 horas",
    openNow: "abierto ahora",
    labels: {
      pharmacy: "farmacias",
      refrigeration: "farmacias",
      charging: "cafés y tiendas",
      cooling: "bibliotecas, cafés y tiendas",
      food: "lugares que venden comida",
      device_power: "lugares",
      info: "lugares",
    },
    utilityNote:
      "Si depende de equipo médico eléctrico, comuníquese también con su compañía eléctrica; muchas llevan una lista de clientes que lo necesitan.",
    call211: "Para encontrar recursos abiertos cerca de usted, llame al 211. Si es una emergencia, llame al 911.",
    emergencyLine: "Si es una emergencia, llame al 911.",
    backupNotice:
      "Funcionando en modo de respaldo (sin IA por ahora), así que las respuestas pueden ser menos flexibles.",
  },
  vi: {
    askLocation: "Mã ZIP của bạn là gì, hoặc ngã tư gần nhất?",
    clarify:
      "Xin lỗi, tôi chưa hiểu. Bạn cần thuốc, thức ăn, nơi mát mẻ hay sạc điện thoại? Hãy cho tôi biết và mã ZIP của bạn.",
    info: "Tôi có thể chỉ bạn đến hiệu thuốc, điểm phát thức ăn, trung tâm làm mát hoặc trạm sạc đang mở và có điện. Hãy cho tôi biết bạn cần gì và mã ZIP.",
    locationNotFound: "Tôi không tìm thấy vị trí đó. Vui lòng gửi mã ZIP 5 chữ số.",
    noVerified: "Tôi chưa có nơi nào được xác nhận đang mở và có điện trong vòng {miles} dặm quanh bạn.",
    nearbyIntro: "Gần nhất ({label}) được ghi nhận đang mở cửa; chúng tôi không thể xác nhận có điện, hãy gọi trước khi đến:",
    confirmedFar: "Đã xác nhận đang mở và có điện, nhưng ở xa hơn:",
    open24h: "mở cửa 24 giờ",
    openNow: "đang mở cửa",
    labels: {
      pharmacy: "hiệu thuốc",
      refrigeration: "hiệu thuốc",
      charging: "quán cà phê và cửa hàng",
      cooling: "thư viện, quán cà phê và cửa hàng",
      food: "nơi bán đồ ăn",
      device_power: "địa điểm",
      info: "địa điểm",
    },
    utilityNote:
      "Nếu bạn dùng thiết bị y tế chạy bằng điện, hãy liên hệ thêm với công ty điện lực; nhiều nơi có danh sách khách hàng cần thiết bị này.",
    call211: "Để tìm các nơi đang mở gần bạn, hãy gọi 211. Nếu là trường hợp khẩn cấp, hãy gọi 911.",
    emergencyLine: "Nếu đây là trường hợp khẩn cấp, hãy gọi 911.",
    backupNotice:
      "Đang chạy ở chế độ dự phòng (tạm thời không có AI), nên câu trả lời có thể kém linh hoạt.",
  },
};

const BRING: Record<NeedType, string> = {
  refrigeration: "a cooler bag or container for the items that need to stay cold",
  device_power: "your device, its power cord, and any adapters",
  pharmacy: "your prescription bottle or ID, if you have them",
  food: "a bag or container, and ID if you have it",
  cooling: "water and anything you need to stay comfortable",
  charging: "your phone and charging cable",
  info: "nothing special",
};

export function bringFor(needType: NeedType): string {
  return BRING[needType];
}

/** FR-1: sent within 3 s of every inbound message, before the language is known. */
export function ackText(): string {
  return "Got it, finding help near you…";
}

/** FR-4: asked once, then conversation state is held. */
export function askLocationText(language: Language = "en"): string {
  return STRINGS[language].askLocation;
}

export function clarifyNeedText(language: Language = "en"): string {
  return STRINGS[language].clarify;
}

export function infoText(language: Language = "en"): string {
  return STRINGS[language].info;
}

export function locationNotFoundText(language: Language = "en"): string {
  return STRINGS[language].locationNotFound;
}

function withEmergencyLine(body: string, tier: Tier, language: Language): string {
  return tier === "medical_critical"
    ? `${body}\n${STRINGS[language].emergencyLine}`
    : body;
}

function withModeNotice(body: string, mode: ProcessingMode, language: Language): string {
  return mode === "degraded" ? `${body}\n${STRINGS[language].backupNotice}` : body;
}

/**
 * FR-5 + FR-6: name, address, distance, hours, what to bring, and the reason.
 * English body; only the 911 line and backup notice follow `language`.
 */
export function routedReplyText(args: {
  match: Match;
  needType: NeedType;
  tier: Tier;
  mode: ProcessingMode;
  /** Set when nothing open is within this many miles: the reply says so before naming the closest option. */
  farMiles?: number;
}): string {
  const { match, needType, tier, mode, farMiles } = args;
  const { resource, distanceMiles, reason } = match;
  const body = [
    ...(farMiles === undefined
      ? []
      : [`Nothing open with power is within ${farMiles} miles of you. This is the closest option.`]),
    `Go to: ${resource.name}`,
    `${resource.address} (${distanceMiles.toFixed(1)} mi)`,
    `Hours: ${formatHours(resource.hours)}`,
    `Bring: ${bringFor(needType)}`,
    `Chosen: ${reason}`,
  ].join("\n");
  // A far answer ends with the 211 line, which already includes 911, so skip the separate 911 line.
  const ending = farMiles === undefined ? withEmergencyLine(body, tier, "en") : `${body}\n${STRINGS.en.call211}`;
  return withModeNotice(ending, mode, "en");
}

/**
 * A real place found by search and listed as open right now. Whether it has power is NOT known.
 * `hours` is "24h" for a place open around the clock, otherwise "open".
 */
export type NearbyPlace = { name: string; address: string; distanceMiles: number; hours?: "24h" | "open" };

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), template);

/**
 * Used when no confirmed open, powered place is within range. It never guesses: it lists
 * unverified nearby pharmacies (clearly labelled), the farther confirmed option if there is
 * one, and always 211 and 911 so anyone, anywhere in the US, leaves with a next step.
 */
export function noMatchText(args: {
  tier: Tier;
  mode: ProcessingMode;
  language?: Language;
  needType?: NeedType;
  /** Search radius to mention. */
  miles?: number;
  places?: readonly NearbyPlace[];
  confirmedFar?: Match;
}): string {
  const language = args.language ?? "en";
  const t = STRINGS[language];
  const lines = [fill(t.noVerified, { miles: String(args.miles ?? 20) })];
  const line = (name: string, address: string, d: number) => `${name}, ${address} (${d.toFixed(1)} mi)`;
  if (args.places && args.places.length > 0) {
    lines.push(fill(t.nearbyIntro, { label: t.labels[args.needType ?? "info"] }));
    args.places.forEach((p, i) => {
      const note = p.hours === "24h" ? t.open24h : t.openNow;
      lines.push(`${i + 1}. ${p.name}, ${p.address} (${p.distanceMiles.toFixed(1)} mi, ${note})`);
    });
  }
  if (args.confirmedFar) {
    const { resource, distanceMiles } = args.confirmedFar;
    lines.push(t.confirmedFar, line(resource.name, resource.address, distanceMiles));
  }
  if (args.needType === "device_power") lines.push(t.utilityNote);
  lines.push(t.call211);
  return withModeNotice(lines.join("\n"), args.mode, language);
}

/**
 * FR-11: the shutoff warning. It states what and when, and tells the person how to get help
 * (reply with what they need). No medical advice.
 */
export function shutoffWarningText(args: { zip: string; shutoffAt: Date; timeZone?: string }): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: args.timeZone ?? "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(args.shutoffAt);
  return [
    `Heads up: a planned power shutoff is scheduled for ZIP ${args.zip} at ${when}.`,
    "If you rely on powered medical equipment or refrigerated medication, reply with what you need and I'll find the nearest open place with power.",
    "If it's an emergency, call 911.",
  ].join("\n");
}
