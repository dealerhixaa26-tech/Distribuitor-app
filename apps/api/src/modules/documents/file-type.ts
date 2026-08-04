/**
 * File type validation by MAGIC BYTES, not by extension or Content-Type.
 *
 * Both of those are attacker-controlled: renaming `shell.php` to `brochure.pdf`
 * changes the extension, and the multipart Content-Type header is whatever the
 * client says it is. The first bytes of the file are the only part that
 * describes what it actually contains.
 *
 * See docs/06-security.md §4 (threat T6).
 */

export interface AllowedType {
  extension: string;
  mimeType: string;
  /** Byte signature at `offset`. Undefined for formats without a stable magic. */
  signature?: number[];
  offset?: number;
  label: string;
}

/**
 * Deliberately narrow: the document types Hixaa actually exchanges — GST
 * certificates, PAN cards, agreements, product brochures, datasheets, and CAD
 * drawings for the engineering side.
 */
export const ALLOWED_TYPES: readonly AllowedType[] = [
  { extension: 'pdf', mimeType: 'application/pdf', signature: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  { extension: 'jpg', mimeType: 'image/jpeg', signature: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { extension: 'png', mimeType: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
  {
    extension: 'webp',
    mimeType: 'image/webp',
    // RIFF container; 'WEBP' sits at offset 8.
    signature: [0x57, 0x45, 0x42, 0x50],
    offset: 8,
    label: 'WebP image',
  },
  {
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // OOXML is a ZIP container.
    signature: [0x50, 0x4b, 0x03, 0x04],
    label: 'Excel workbook',
  },
  {
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: [0x50, 0x4b, 0x03, 0x04],
    label: 'Word document',
  },
  // CSV, DXF, and STEP are plain text with no reliable magic. Accepted without
  // a signature check, which is safe because they are never executed and are
  // always served as an attachment.
  { extension: 'csv', mimeType: 'text/csv', label: 'CSV' },
  { extension: 'dxf', mimeType: 'application/dxf', label: 'CAD drawing (DXF)' },
  { extension: 'step', mimeType: 'application/step', label: 'CAD model (STEP)' },
] as const;

export interface DetectionResult {
  ok: boolean;
  type?: AllowedType;
  reason?: string;
}

/** Extensions that are never accepted, whatever the bytes say. */
const NEVER_ALLOWED = new Set([
  'exe', 'dll', 'so', 'dylib', 'bat', 'cmd', 'com', 'sh', 'bash', 'ps1',
  'js', 'mjs', 'jar', 'php', 'py', 'rb', 'pl', 'asp', 'aspx', 'jsp',
  'html', 'htm', 'svg', 'xhtml',
]);

/**
 * Validates a file against the allow-list.
 *
 * The extension narrows the candidates; the magic bytes decide. A `.pdf` whose
 * bytes are a ZIP is rejected — that mismatch is the signature of a disguised
 * payload, not an honest mislabel.
 *
 * SVG is excluded on purpose despite being an image: it is XML that can carry
 * script, and browsers execute it when rendered inline.
 */
export function detectFileType(
  filename: string,
  buffer: Buffer,
  declaredMimeType?: string,
): DetectionResult {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';

  if (!extension) {
    return { ok: false, reason: 'File has no extension.' };
  }
  if (NEVER_ALLOWED.has(extension)) {
    return { ok: false, reason: `.${extension} files are not accepted.` };
  }

  const candidates = ALLOWED_TYPES.filter((type) => type.extension === extension);
  if (candidates.length === 0) {
    const allowed = [...new Set(ALLOWED_TYPES.map((t) => t.extension))].join(', ');
    return { ok: false, reason: `.${extension} is not an accepted type. Allowed: ${allowed}.` };
  }

  const signed = candidates.filter((type) => type.signature);

  // Formats with no stable magic (CSV, DXF, STEP) pass on extension alone.
  if (signed.length === 0) {
    return { ok: true, type: candidates[0] };
  }

  const matched = signed.find((type) => matchesSignature(buffer, type));
  if (!matched) {
    return {
      ok: false,
      reason:
        `The file's contents do not match its .${extension} extension. ` +
        'It may be corrupted, or renamed from another format.',
    };
  }

  // A mismatched Content-Type is worth noting but not worth rejecting: browsers
  // and upload libraries get it wrong routinely, and the bytes already agreed.
  if (declaredMimeType && declaredMimeType !== matched.mimeType) {
    return { ok: true, type: matched };
  }

  return { ok: true, type: matched };
}

function matchesSignature(buffer: Buffer, type: AllowedType): boolean {
  if (!type.signature) return true;
  const offset = type.offset ?? 0;
  if (buffer.length < offset + type.signature.length) return false;

  return type.signature.every((byte, index) => buffer[offset + index] === byte);
}

/** Human-readable size, for error messages. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
