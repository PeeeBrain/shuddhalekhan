declare module 'sherpa-onnx-node' {
  export const version: string;
  export const onnxruntimeVersion: string;
  export interface OfflineRecognizerConfig {
    decodingMethod?: 'greedy_search' | 'modified_beam_search';
    maxActivePaths?: number;
    hotwordsScore?: number;
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: string;
      modelType: 'nemo_transducer';
      debug: boolean;
      modelingUnit?: 'bpe';
      bpeVocab?: string;
    };
  }

  export interface OfflineStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
  }

  export interface OfflineRecognizerResult {
    text: string;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }

  export class OnlinePunctuation {
    constructor(config: { model: { cnnBilstm: string; bpeVocab: string; numThreads: number; provider: string } });
    addPunct(text: string): string;
  }
}
