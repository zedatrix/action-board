// Display settings from app/.env.local, exposed by the client allowlist in vite.config.ts.

// The assistant's name in the UI: "Message <name>", "Sent to <name>".
export const ASSISTANT_NAME = import.meta.env.ACTION_BOARD_ASSISTANT_NAME?.trim() || "your assistant";

// The IANA time zone for card stamps, the header date and the project tab's "Last updated".
export const TIME_ZONE = import.meta.env.ACTION_BOARD_TIMEZONE?.trim() || "America/New_York";
