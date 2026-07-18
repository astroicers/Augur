/**
 * Edge TTS provider（免金鑰、支援中文）。把要念的句子合成成 base64 MP3，
 * 由 broadcastSink 透過 WS 送給前端，前端用 <audio>+AnalyserNode 做振幅 lip-sync。
 * 全 TS/Node，live 迴路零 Python。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export interface TTSProvider {
  /** 回傳 base64 編碼的 MP3。合成失敗時 throw，由呼叫端決定如何降級。 */
  synth(text: string): Promise<string>
}

/** voice 例：zh → 'zh-TW-HsiaoChenNeural'、en → 'en-US-AriaNeural'。 */
export function createEdgeTTS(voice: string): TTSProvider {
  return {
    async synth(text: string): Promise<string> {
      const tts = new MsEdgeTTS()
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      const { audioStream } = tts.toStream(text)
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        audioStream.on('data', (c: Buffer) => chunks.push(c))
        audioStream.on('end', resolve)
        audioStream.on('close', resolve)
        audioStream.on('error', reject)
      })
      try {
        tts.close()
      } catch {
        // 某些版本沒有 close()，忽略
      }
      return Buffer.concat(chunks).toString('base64')
    },
  }
}
