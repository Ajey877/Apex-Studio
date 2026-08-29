declare module './daw' {
  interface MasterMacroKnob {
    id: string;
    name: string;
    value: number;
    color: string;
    mappings: Array<{
      targetType: 'channel_volume' | 'channel_pan' | 'mixer_volume' | 'mixer_pan' | 'filter_cutoff' | 'reverb_wet' | 'delay_feedback';
      targetId: string | number;
      min: number;
      max: number;
      curve?: 'linear' | 'exponential' | 'logarithmic';
    }>;
  }
}
export {};
