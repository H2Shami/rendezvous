export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed";
export const isTerminal = (status?: string) =>
  ["CLOSED", "EXPIRED"].includes(status?.toUpperCase() || "");
