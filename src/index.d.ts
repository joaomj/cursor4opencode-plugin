declare const cursorAgentPlugin: () => Promise<{
  tool: Record<string, unknown>;
}>;

export default cursorAgentPlugin;
