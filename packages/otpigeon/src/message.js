import { invalid } from "./errors.js";
export const isPhone = (value) =>
  typeof value === "string" &&
  value === value.trim() &&
  /^\+[1-9][0-9]{1,14}$/.test(value);
export const isChatId = (value) =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[0-9]{1,32}@(c\.us|lid)$/.test(value);
export function normalizeMessage(
  kind,
  input,
  maxMediaBytes = 8 * 1024 * 1024,
  allowChat = false,
) {
  if (!input || typeof input !== "object")
    throw invalid("Message must be an object");
  const { to, chatId, text, data, mimeType, filename, caption, replyTo } =
    input;
  if (allowChat && chatId !== undefined) {
    if (!isChatId(chatId) || to !== undefined)
      throw invalid("Invalid direct chat identifier");
  } else if (!isPhone(to) || chatId !== undefined)
    throw invalid("to must include + and the country calling code");
  if (
    replyTo !== undefined &&
    (!allowChat ||
      typeof replyTo !== "string" ||
      !replyTo.length ||
      replyTo.length > 256 ||
      /[\r\n]/.test(replyTo))
  )
    throw invalid("Invalid reply identifier");
  const result = {
    kind,
    ...(chatId ? { chatId } : { to }),
    ...(replyTo ? { replyTo } : {}),
  };
  if (kind === "text") {
    if (typeof text !== "string" || !text.trim() || text.length > 4096)
      throw invalid("text must contain 1–4096 characters");
    return { ...result, text };
  }
  if (!["image", "document"].includes(kind))
    throw invalid("Unsupported message kind");
  if (
    !(data instanceof Uint8Array) ||
    !data.byteLength ||
    data.byteLength > maxMediaBytes
  )
    throw invalid(`data must contain 1–${maxMediaBytes} bytes`);
  if (
    typeof mimeType !== "string" ||
    mimeType !== mimeType.trim() ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) ||
    mimeType.length > 128
  )
    throw invalid("Invalid MIME type");
  if (
    kind === "image" &&
    !["image/jpeg", "image/png", "image/webp"].includes(mimeType)
  )
    throw invalid("Images must be JPEG, PNG or WebP");
  if (
    typeof filename !== "string" ||
    !filename ||
    filename.length > 160 ||
    filename === "." ||
    filename === ".." ||
    /[\\/\x00-\x1f\x7f]/.test(filename)
  )
    throw invalid("filename must be a plain filename, not a path");
  if (
    caption !== undefined &&
    (typeof caption !== "string" || caption.length > 1024)
  )
    throw invalid("caption must contain at most 1024 characters");
  return {
    ...result,
    data: Buffer.from(data),
    mimeType,
    filename,
    ...(caption !== undefined ? { caption } : {}),
  };
}
