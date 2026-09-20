declare module 'sherpa-onnx-node' {
  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: 'cpu';
      modelType: 'nemo_transducer';
      debug: boolean;
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
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }
}
