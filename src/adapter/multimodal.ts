/**
 * Multimodal file resolution for Google Gemini on Antigravity.
 *
 * In DeepSeek Harness (DSH), non-image files (PDF, audio, video, etc.)
 * uploaded by users are converted by DSH's LLM runtime into deterministic
 * text handles:
 *
 * `[File "${name}" (${bytes} bytes, sha256:${digest}): verbatim read-only copy saved at "${readonlyPath}". ...]`
 *
 * Gemini models natively support these files as base64-encoded `inlineData`
 * parts alongside text. Claude models running behind the Antigravity Vertex
 * proxy reject non-image `inlineData` with 500, so injection is scoped strictly
 * to Gemini (non-Claude, vision-capable) models.
 */

import { readFile } from 'node:fs/promises'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { catalogModel } from './catalog.ts'
import { normalizeMessages } from './dsh-view.ts'

/**
 * MIME type mapping for Gemini supported multimodal formats.
 *
 * Covered formats (PDF observed live end-to-end; the rest follow Gemini's
 * documented multimodal support and are not yet live-verified):
 * - Document: .pdf -> 'application/pdf'
 * - Audio: .mp3 -> 'audio/mp3', .wav -> 'audio/wav', .m4a -> 'audio/m4a', .aac -> 'audio/aac', .ogg -> 'audio/ogg', .flac -> 'audio/flac'
 * - Video: .mp4 -> 'video/mp4', .mov -> 'video/quicktime', .webm -> 'video/webm'
 * - Extended image: .bmp -> 'image/bmp', .heic -> 'image/heic', .heif -> 'image/heif'
 */
export const GEMINI_MULTIMODAL_MIMES: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.m4a': 'audio/m4a',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
})

/**
 * Regex matching DSH's deterministic read-only file handle blocks.
 * Capture groups:
 * 1: file name
 * 2: file size in bytes
 * 3: local read-only filesystem path
 */
export const DSH_FILE_HANDLE_REGEX =
  /\[File "([^"]+)" \((\d+) bytes, sha256:[a-f0-9]+\): verbatim read-only copy saved at "([^"]+)"\./g

export const FILE_HANDLE_REGEX = DSH_FILE_HANDLE_REGEX

/** Maximum file size for inlining (20MB). */
export const MAX_MULTIMODAL_FILE_BYTES = 20 * 1024 * 1024
export const MAX_MULTIMODAL_FILE_SIZE = MAX_MULTIMODAL_FILE_BYTES

export interface ExtractedFileHandle {
  name: string
  bytes: number
  readonlyPath: string
}

/** Extract file handle descriptors from text content. */
export function extractFileHandles(text: string): ExtractedFileHandle[] {
  const regex = new RegExp(DSH_FILE_HANDLE_REGEX.source, 'g')
  const results: ExtractedFileHandle[] = []
  for (const match of text.matchAll(regex)) {
    const [, name, bytesStr, readonlyPath] = match
    if (name && bytesStr && readonlyPath) {
      const bytes = parseInt(bytesStr, 10)
      if (!Number.isNaN(bytes)) {
        results.push({ name, bytes, readonlyPath })
      }
    }
  }
  return results
}

/** Resolve MIME type for a file name or path based on extension. */
export function getMultimodalMimeType(filenameOrPath: string): string | undefined {
  const dotIndex = filenameOrPath.lastIndexOf('.')
  if (dotIndex === -1) return undefined
  const ext = filenameOrPath.slice(dotIndex + 1).toLowerCase()
  return GEMINI_MULTIMODAL_MIMES[ext]
}

/** Whether a model id belongs to a Claude-branded model (Vertex-hosted). */
export function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-') || model.includes('/claude')
}

/**
 * Check whether a model supports Gemini multimodal file inlineData.
 * Deny-by-default: Claude models are always excluded (Vertex 500 on
 * non-image inlineData), catalog models must be vision-capable, and ids
 * unknown to the catalog are only allowed when they carry the `gemini-`
 * prefix (so future tiered ids keep working without a catalog bump).
 */
export function supportsMultimodalFiles(model: string): boolean {
  if (isClaudeModel(model)) return false
  const meta = catalogModel(model)
  if (meta) return meta.supportsVision === true
  return model.startsWith('gemini-')
}

export const isMultimodalSupported = supportsMultimodalFiles
export const isMultimodalModel = supportsMultimodalFiles

export interface AgyResolvedMultimodalFile {
  mimeType: string
  /** Pure base64 (no data: prefix). */
  data: string
  name?: string
  path?: string
  bytes?: number
}

export interface ResolveMultimodalOptions {
  readFile?: (path: string) => Promise<Buffer | Uint8Array>
  /**
   * Effective per-file cap, in bytes. Defaults to
   * `MAX_MULTIMODAL_FILE_BYTES`; the settings store supplies its own value
   * through the adapter (`AgyAdapterOptions.maxInlineBytes`).
   */
  maxBytes?: number
}

/**
 * Resolve multimodal files referenced in user messages.
 *
 * Reads local files up to the effective cap (20MB by default) into base64
 * strings. Silently ignores missing/unreadable files or files exceeding the size
 * limit so the original text handle block remains intact in the prompt.
 */
export async function resolveMultimodalFiles(
  optionsOrMessages: GenerateOptions | readonly unknown[],
  modelOrOptions?: string | ResolveMultimodalOptions,
  extraOptions?: ResolveMultimodalOptions,
): Promise<Map<string, AgyResolvedMultimodalFile[]>> {
  let raw: readonly unknown[]
  let model: string
  let customOptions: ResolveMultimodalOptions | undefined

  if ('messages' in optionsOrMessages) {
    raw = optionsOrMessages.messages ?? []
    model = optionsOrMessages.model ?? ''
    customOptions = typeof modelOrOptions === 'object' ? modelOrOptions : extraOptions
  } else {
    raw = optionsOrMessages
    if (typeof modelOrOptions === 'string') {
      model = modelOrOptions
      customOptions = extraOptions
    } else {
      model = ''
      customOptions = modelOrOptions
    }
  }

  // Normalized through the same boundary the translator uses, so this path sees
  // one vocabulary whichever dsh-llm line fed the request (see dsh-view.ts).
  const messages = normalizeMessages(raw)

  const result = new Map<string, AgyResolvedMultimodalFile[]>()
  if (!supportsMultimodalFiles(model)) {
    return result
  }

  const readFn = customOptions?.readFile ?? readFile
  // Both checks below use this SAME value: a handle that under-declares its
  // size would otherwise pass the declared check and be caught by a different
  // limit than the configured one.
  const cap = customOptions?.maxBytes ?? MAX_MULTIMODAL_FILE_BYTES

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue

    const resolvedForMessage: AgyResolvedMultimodalFile[] = []
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue

      const handles = extractFileHandles(block.text)
      for (const handle of handles) {
        if (handle.bytes > cap) continue

        const mimeType = getMultimodalMimeType(handle.name) ?? getMultimodalMimeType(handle.readonlyPath)
        if (!mimeType) continue

        try {
          const fileBuffer = await readFn(handle.readonlyPath)
          if (fileBuffer.length > cap) continue
          resolvedForMessage.push({
            mimeType,
            data: Buffer.from(fileBuffer).toString('base64'),
            name: handle.name,
            path: handle.readonlyPath,
            bytes: fileBuffer.length,
          })
        } catch {
          // Error resilience: catch error silently and do not throw
          continue
        }
      }
    }

    if (resolvedForMessage.length > 0) {
      const key = message.id ?? `msg-${i}`
      result.set(key, resolvedForMessage)
    }
  }

  return result
}
