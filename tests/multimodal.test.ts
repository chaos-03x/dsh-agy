import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  DSH_FILE_HANDLE_REGEX,
  FILE_HANDLE_REGEX,
  GEMINI_MULTIMODAL_MIMES,
  MAX_MULTIMODAL_FILE_BYTES,
  MAX_MULTIMODAL_FILE_SIZE,
  extractFileHandles,
  getMultimodalMimeType,
  isClaudeModel,
  isMultimodalModel,
  isMultimodalSupported,
  resolveMultimodalFiles,
  supportsMultimodalFiles,
} from '../src/adapter/multimodal.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'

describe('multimodal constants & MIME types', () => {
  it('defines all required Gemini multimodal MIME types with and without leading dot', () => {
    // Document
    expect(GEMINI_MULTIMODAL_MIMES['pdf']).toBe('application/pdf')
    expect(GEMINI_MULTIMODAL_MIMES['.pdf']).toBe('application/pdf')

    // Audio
    expect(GEMINI_MULTIMODAL_MIMES['mp3']).toBe('audio/mp3')
    expect(GEMINI_MULTIMODAL_MIMES['.mp3']).toBe('audio/mp3')
    expect(GEMINI_MULTIMODAL_MIMES['wav']).toBe('audio/wav')
    expect(GEMINI_MULTIMODAL_MIMES['.wav']).toBe('audio/wav')
    expect(GEMINI_MULTIMODAL_MIMES['m4a']).toBe('audio/m4a')
    expect(GEMINI_MULTIMODAL_MIMES['.m4a']).toBe('audio/m4a')
    expect(GEMINI_MULTIMODAL_MIMES['aac']).toBe('audio/aac')
    expect(GEMINI_MULTIMODAL_MIMES['.aac']).toBe('audio/aac')
    expect(GEMINI_MULTIMODAL_MIMES['ogg']).toBe('audio/ogg')
    expect(GEMINI_MULTIMODAL_MIMES['.ogg']).toBe('audio/ogg')
    expect(GEMINI_MULTIMODAL_MIMES['flac']).toBe('audio/flac')
    expect(GEMINI_MULTIMODAL_MIMES['.flac']).toBe('audio/flac')

    // Video
    expect(GEMINI_MULTIMODAL_MIMES['mp4']).toBe('video/mp4')
    expect(GEMINI_MULTIMODAL_MIMES['.mp4']).toBe('video/mp4')
    expect(GEMINI_MULTIMODAL_MIMES['mov']).toBe('video/quicktime')
    expect(GEMINI_MULTIMODAL_MIMES['.mov']).toBe('video/quicktime')
    expect(GEMINI_MULTIMODAL_MIMES['webm']).toBe('video/webm')
    expect(GEMINI_MULTIMODAL_MIMES['.webm']).toBe('video/webm')

    // Extended image
    expect(GEMINI_MULTIMODAL_MIMES['bmp']).toBe('image/bmp')
    expect(GEMINI_MULTIMODAL_MIMES['.bmp']).toBe('image/bmp')
    expect(GEMINI_MULTIMODAL_MIMES['heic']).toBe('image/heic')
    expect(GEMINI_MULTIMODAL_MIMES['.heic']).toBe('image/heic')
    expect(GEMINI_MULTIMODAL_MIMES['heif']).toBe('image/heif')
    expect(GEMINI_MULTIMODAL_MIMES['.heif']).toBe('image/heif')
  })

  it('resolves MIME types case-insensitively and handles paths', () => {
    expect(getMultimodalMimeType('document.PDF')).toBe('application/pdf')
    expect(getMultimodalMimeType('/path/to/recording.MP3')).toBe('audio/mp3')
    expect(getMultimodalMimeType('video.Mp4')).toBe('video/mp4')
    expect(getMultimodalMimeType('photo.HEIC')).toBe('image/heic')
    expect(getMultimodalMimeType('photo.bmp')).toBe('image/bmp')
    expect(getMultimodalMimeType('plain.txt')).toBeUndefined()
    expect(getMultimodalMimeType('archive.zip')).toBeUndefined()
    expect(getMultimodalMimeType('no_extension')).toBeUndefined()
  })

  it('defines max file size limit of 20MB', () => {
    expect(MAX_MULTIMODAL_FILE_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_MULTIMODAL_FILE_SIZE).toBe(20 * 1024 * 1024)
  })
})

describe('extractFileHandles & regex', () => {
  it('extracts DSH file handles from text blocks', () => {
    const text =
      '[File "doc.pdf" (1024 bytes, sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890): verbatim read-only copy saved at "/workspace/doc.pdf". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]'

    const handles = extractFileHandles(text)
    expect(handles).toHaveLength(1)
    expect(handles[0]).toEqual({
      name: 'doc.pdf',
      bytes: 1024,
      readonlyPath: '/workspace/doc.pdf',
    })
  })

  it('extracts multiple file handles from one text string', () => {
    const text = `Here are two files:
[File "speech.mp3" (2048000 bytes, sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): verbatim read-only copy saved at "/tmp/speech.mp3". Please read.]
and also
[File "clip.mp4" (5120000 bytes, sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef): verbatim read-only copy saved at "/tmp/clip.mp4". Please read.]`

    const handles = extractFileHandles(text)
    expect(handles).toHaveLength(2)
    expect(handles[0]).toEqual({
      name: 'speech.mp3',
      bytes: 2048000,
      readonlyPath: '/tmp/speech.mp3',
    })
    expect(handles[1]).toEqual({
      name: 'clip.mp4',
      bytes: 5120000,
      readonlyPath: '/tmp/clip.mp4',
    })
  })

  it('returns empty array when text does not match DSH format', () => {
    expect(extractFileHandles('Just ordinary text with no handles.')).toEqual([])
    expect(extractFileHandles('[File broken handle')).toEqual([])
  })

  it('exports aliases for regex and helpers', () => {
    expect(FILE_HANDLE_REGEX).toBe(DSH_FILE_HANDLE_REGEX)
    expect(isMultimodalSupported).toBe(supportsMultimodalFiles)
    expect(isMultimodalModel).toBe(supportsMultimodalFiles)
  })
})

describe('supportsMultimodalFiles guardrails', () => {
  it('enables multimodal files for Gemini models', () => {
    expect(supportsMultimodalFiles('gemini-3.8-flash-tiered')).toBe(true)
    expect(supportsMultimodalFiles('gemini-3.7-flash-tiered')).toBe(true)
    expect(supportsMultimodalFiles('gemini-3.6-flash-high')).toBe(true)
    expect(supportsMultimodalFiles('gemini-2.5-flash')).toBe(true)
    expect(supportsMultimodalFiles('gemini-pro-agent')).toBe(true)
  })

  it('enables multimodal files for dynamic tiered models', () => {
    expect(supportsMultimodalFiles('gemini-3.9-flash-tiered')).toBe(true)
    expect(supportsMultimodalFiles('gemini-4.0-flash-tiered')).toBe(true)
  })

  it('disables multimodal files for Claude models (Vertex 500 guardrail)', () => {
    expect(supportsMultimodalFiles('claude-opus-4-6-thinking')).toBe(false)
    expect(supportsMultimodalFiles('claude-sonnet-4-6')).toBe(false)
    expect(supportsMultimodalFiles('claude-3-5-sonnet')).toBe(false)
    expect(supportsMultimodalFiles('anthropic/claude-3-7-sonnet')).toBe(false)
    expect(isClaudeModel('claude-opus-4-6-thinking')).toBe(true)
    expect(isClaudeModel('gemini-3.8-flash-tiered')).toBe(false)
  })

  it('disables multimodal files for text-only models in catalog', () => {
    expect(supportsMultimodalFiles('gpt-oss-120b-medium')).toBe(false)
  })

  it('denies non-Gemini unknown models (deny-by-default)', () => {
    expect(supportsMultimodalFiles('some-new-gemini')).toBe(false)
    expect(supportsMultimodalFiles('unknown-model-xyz')).toBe(false)
    expect(supportsMultimodalFiles('gpt-5-turbo')).toBe(false)
  })

  it('still enables unknown gemini-prefixed ids (dynamic tiered ids)', () => {
    expect(supportsMultimodalFiles('gemini-3.9-flash-tiered')).toBe(true)
    expect(supportsMultimodalFiles('gemini-4.0-flash-tiered')).toBe(true)
    expect(supportsMultimodalFiles('gemini-5-pro-agent')).toBe(true)
  })
})

describe('resolveMultimodalFiles', () => {
  function makeDshFileText(name: string, bytes: number, path: string): string {
    return `[File "${name}" (${bytes} bytes, sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): verbatim read-only copy saved at "${path}". Read that path with your file tools when its contents are needed.]`
  }

  it('resolves valid multimodal files to base64 inlineData', async () => {
    const fileBytes = Buffer.from('%PDF-1.4 test pdf content')
    const readFile = vi.fn().mockResolvedValue(fileBytes)

    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('sample.pdf', 100, '/path/to/sample.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).toHaveBeenCalledWith('/path/to/sample.pdf')
    expect(resolved.get('msg-1')).toEqual([
      {
        mimeType: 'application/pdf',
        data: fileBytes.toString('base64'),
        name: 'sample.pdf',
        path: '/path/to/sample.pdf',
        bytes: fileBytes.length,
      },
    ])
  })

  it('skips reading when model is a Claude model', async () => {
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('doc.pdf', 100, '/path/to/doc.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'claude-opus-4-6-thinking', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('skips reading when model is text-only (e.g. gpt-oss-120b-medium)', async () => {
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('doc.pdf', 100, '/path/to/doc.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gpt-oss-120b-medium', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('skips files exceeding MAX_MULTIMODAL_FILE_BYTES (20MB) by handle declaration', async () => {
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('huge.mp4', 25 * 1024 * 1024, '/path/to/huge.mp4'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('skips files exceeding MAX_MULTIMODAL_FILE_BYTES (20MB) by actual read size', async () => {
    const hugeBuffer = Buffer.alloc(21 * 1024 * 1024)
    const readFile = vi.fn().mockResolvedValue(hugeBuffer)
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('large.pdf', 1000, '/path/to/large.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).toHaveBeenCalledWith('/path/to/large.pdf')
    expect(resolved.size).toBe(0)
  })

  it('skips an over-cap file by declaration under an INJECTED cap, without reading it', async () => {
    // The declared size is checked BEFORE the read, so an oversized file costs
    // no I/O at all — and the check must use the INJECTED cap, not the 20MB
    // constant, or a lowered setting would still inline up to 20MB.
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('big.pdf', 3 * 1024 * 1024, '/path/to/big.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile, maxBytes: 1024 * 1024 },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('allows a file exactly at the injected cap', async () => {
    // `>` and not `>=`: the boundary is the largest file that may be inlined,
    // and an off-by-one silently rejects the very value the user typed.
    const cap = 1024
    const readFile = vi.fn().mockResolvedValue(Buffer.alloc(cap))
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('exact.pdf', cap, '/path/to/exact.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile, maxBytes: cap },
    )

    expect(readFile).toHaveBeenCalledWith('/path/to/exact.pdf')
    expect(resolved.get('msg-1')).toHaveLength(1)
  })

  it('catches a handle that under-declares its size with the SAME injected cap', async () => {
    // The declared-size check is a cheap pre-filter, not a guarantee: the real
    // bytes arrive only after the read. Both checks must therefore compare
    // against one effective value — using the 20MB constant post-read would let
    // a 2MB file through a 1MB setting.
    const readFile = vi.fn().mockResolvedValue(Buffer.alloc(2 * 1024 * 1024))
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            // Declares 10 bytes; the read returns 2MB.
            text: makeDshFileText('liar.pdf', 10, '/path/to/liar.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile, maxBytes: 1024 * 1024 },
    )

    expect(readFile).toHaveBeenCalledWith('/path/to/liar.pdf')
    expect(resolved.size).toBe(0)
  })

  it('silently ignores files when readFile throws (error resilience)', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'))
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('deleted.pdf', 500, '/path/to/deleted.pdf'),
          },
        ],
      },
    ]

    // Must not throw error!
    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('skips unsupported file extensions (e.g. .txt, .zip)', async () => {
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('notes.txt', 500, '/path/to/notes.txt'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('skips non-user messages', async () => {
    const readFile = vi.fn()
    const messages = [
      {
        id: 'msg-assistant',
        role: 'assistant' as const,
        content: [
          {
            type: 'text' as const,
            text: makeDshFileText('doc.pdf', 100, '/path/to/doc.pdf'),
          },
        ],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('supports resolving multiple files across multiple user messages', async () => {
    const pdfBuf = Buffer.from('pdf data')
    const mp3Buf = Buffer.from('mp3 data')
    const readFile = vi.fn().mockImplementation((path: string) => {
      if (path === '/path/doc.pdf') return Promise.resolve(pdfBuf)
      if (path === '/path/audio.mp3') return Promise.resolve(mp3Buf)
      throw new Error('unknown path')
    })

    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: makeDshFileText('doc.pdf', 10, '/path/doc.pdf') }],
      },
      {
        id: 'asst-1',
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Understood' }],
      },
      {
        id: 'user-2',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: makeDshFileText('audio.mp3', 20, '/path/audio.mp3') }],
      },
    ]

    const resolved = await resolveMultimodalFiles(
      { provider: 'agy', model: 'gemini-3.8-flash-tiered', messages } as GenerateOptions,
      { readFile },
    )

    expect(resolved.get('user-1')).toHaveLength(1)
    expect(resolved.get('user-1')![0]).toMatchObject({
      mimeType: 'application/pdf',
      data: pdfBuf.toString('base64'),
    })
    expect(resolved.get('user-2')).toHaveLength(1)
    expect(resolved.get('user-2')![0]).toMatchObject({
      mimeType: 'audio/mp3',
      data: mp3Buf.toString('base64'),
    })
  })
})

describe('translate: toAgyRequestBody multimodal integration', () => {
  it('appends inlineData parts to user message while keeping original text handle block', () => {
    const fileHandleText =
      '[File "analysis.pdf" (1000 bytes, sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): verbatim read-only copy saved at "/data/analysis.pdf".]'
    const userPrompt = 'Please summarize this PDF file.'
    const fullText = `${fileHandleText}\n${userPrompt}`

    const messages = [
      {
        id: 'msg-u1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: fullText }],
      },
    ]

    const multimodalFiles = new Map([
      [
        'msg-u1',
        [
          {
            mimeType: 'application/pdf',
            data: Buffer.from('pdf contents').toString('base64'),
          },
        ],
      ],
    ])

    const body = toAgyRequestBody(
      {
        provider: 'agy',
        model: 'gemini-3.8-flash-tiered',
        messages,
      } as GenerateOptions,
      { multimodalFiles },
    )

    expect(body.request.contents).toHaveLength(1)
    const parts = body.request.contents[0]!.parts
    expect(parts).toHaveLength(2)
    // 1. Original text handle block preserved
    expect(parts[0]).toEqual({ text: fullText })
    // 2. Multimodal inlineData part appended
    expect(parts[1]).toEqual({
      inlineData: {
        mimeType: 'application/pdf',
        data: Buffer.from('pdf contents').toString('base64'),
      },
    })
  })

  it('does NOT inject multimodal inlineData on Claude models even if multimodalFiles passed', () => {
    const text =
      '[File "analysis.pdf" (1000 bytes, sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): verbatim read-only copy saved at "/data/analysis.pdf".]'
    const messages = [
      {
        id: 'msg-u1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
      },
    ]

    const multimodalFiles = new Map([
      [
        'msg-u1',
        [
          {
            mimeType: 'application/pdf',
            data: 'cGRm',
          },
        ],
      ],
    ])

    const body = toAgyRequestBody(
      {
        provider: 'agy',
        model: 'claude-opus-4-6-thinking',
        messages,
      } as GenerateOptions,
      { multimodalFiles },
    )

    expect(body.request.contents).toHaveLength(1)
    const parts = body.request.contents[0]!.parts
    // Claude request has only the original text, no multimodal inlineData part!
    expect(parts).toEqual([{ text }])
  })

  it('supports multiple multimodal files attached to a single user message', () => {
    const messages = [
      {
        id: 'msg-multi',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Look at both files.' }],
      },
    ]

    const multimodalFiles = new Map([
      [
        'msg-multi',
        [
          { mimeType: 'audio/mp3', data: 'YXVkaW8=' },
          { mimeType: 'video/mp4', data: 'dmlkZW8=' },
        ],
      ],
    ])

    const body = toAgyRequestBody(
      {
        provider: 'agy',
        model: 'gemini-3.6-flash-high',
        messages,
      } as GenerateOptions,
      { multimodalFiles },
    )

    const parts = body.request.contents[0]!.parts
    expect(parts).toEqual([
      { text: 'Look at both files.' },
      { inlineData: { mimeType: 'audio/mp3', data: 'YXVkaW8=' } },
      { inlineData: { mimeType: 'video/mp4', data: 'dmlkZW8=' } },
    ])
  })
})
