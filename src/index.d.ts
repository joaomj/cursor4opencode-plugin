declare const cursorProxyPlugin: () => Promise<{
  config: (cfg: Record<string, unknown>) => void;
}>;

export default cursorProxyPlugin;
