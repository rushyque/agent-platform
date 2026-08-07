import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";

// Unified front-end interaction tool (show_ui).
//
// Replaces the old four-tool set (guide_user / present_choices / notify / open_link)
// with a single tool the model calls with a `mode` parameter. The backend is still a
// no-op: it returns a structured UI directive {ui:{type,...}, hint}. The front-end
// (ai-assistant.js dispatchUI) intercepts TOOL_CALL_RESULT, reads parsed.ui.type, and
// executes the real DOM/page action. The front-end does NOT care about the tool name.
//
// Field naming stays the same (ui/hint) so the existing front-end dispatcher is untouched.
// We still avoid summarizeToolResult priority fields (trace/summary/message/error/detail/data)
// and rely on safeStringify fallback to pass the full JSON through to the front-end.

export const showUiTool: ToolDefinition = {
  name: "show_ui",
  description:
    "Interact with the user's page via a structured UI directive. Four modes:\n" +
    "- guide: scroll to + highlight a page area (target). Use when suggesting the user look at something.\n" +
    "- choices: show clickable option buttons in the chat. Use when the user must pick from 2-6 options.\n" +
    "- notify: show a brief page toast. Use for status updates that don't require immediate action.\n" +
    "- open_link: open a URL or navigate to a route. Use to guide the user to a specific page.",
  parameters: z.object({
    mode: z
      .enum(["guide", "choices", "notify", "open_link"])
      .describe("Which UI action to perform"),
    // -- guide mode --
    target: z
      .string()
      .optional()
      .describe("[guide] Page area id (from context.domMap). e.g. workshop / orders / dashboard"),
    note: z
      .string()
      .optional()
      .describe("[guide] One-line explanation shown on the tool card"),
    // -- choices mode --
    prompt: z
      .string()
      .optional()
      .describe("[choices] Lead-in text before the buttons, e.g. 'Accept this quote?'"),
    choices: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          style: z
            .enum(["default", "primary", "success", "warning", "danger"])
            .optional(),
        })
      )
      .max(6)
      .optional()
      .describe("[choices] 2-6 option buttons"),
    // -- notify mode --
    message: z
      .string()
      .optional()
      .describe("[notify] Toast text, one short sentence"),
    level: z
      .enum(["info", "success", "warning", "error"])
      .optional()
      .describe("[notify] Toast level, default info"),
    // -- open_link mode --
    url: z
      .string()
      .optional()
      .describe("[open_link] URL or route, e.g. '/orders/123' or 'https://...'"),
    label: z
      .string()
      .optional()
      .describe("[open_link] Human-readable link name for the tool card"),
    openMode: z
      .enum(["auto", "tab", "navigate"])
      .optional()
      .describe("[open_link] How to open: auto / tab(new tab) / navigate(current page)"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const mode = args.mode as string;

    // --- guide ---
    if (mode === "guide") {
      const target = String(args.target || "");
      if (!target) {
        return { ok: false, ui: { type: "guide", target: "", valid: false }, hint: "Missing target." };
      }
      const domMap = (context as any).domMap as Record<string, string> | undefined;
      const label = domMap?.[target];
      if (domMap && !label) {
        return {
          ok: false,
          ui: { type: "guide", target, valid: false },
          hint:
            "Target '" + target + "' not in current system's area map. Available: " +
            Object.keys(domMap).join(", "),
        };
      }
      return {
        ok: true,
        ui: { type: "guide", target },
        hint: args.note || (label ? "Guide to " + label : "Guide to " + target),
      };
    }

    // --- choices ---
    if (mode === "choices") {
      const choices = Array.isArray(args.choices) ? args.choices : [];
      return {
        ok: true,
        ui: {
          type: "choices",
          prompt: String(args.prompt || ""),
          choices: choices.map((c: any) => ({
            label: String(c.label || ""),
            value: String(c.value || c.label || ""),
            style: c.style || "default",
          })),
        },
        hint: args.prompt || choices.length + " options",
      };
    }

    // --- notify ---
    if (mode === "notify") {
      const level = args.level || "info";
      return {
        ok: true,
        ui: { type: "notify", message: String(args.message || ""), level },
        hint: "[" + level + "] " + (args.message || ""),
      };
    }

    // --- open_link ---
    if (mode === "open_link") {
      const url = String(args.url || "");
      return {
        ok: true,
        ui: {
          type: "open_link",
          url,
          label: args.label || url,
          mode: args.openMode || "auto",
        },
        hint: args.label ? "Open " + args.label : "Open " + url,
      };
    }

    return { ok: false, error: "Unknown mode: " + mode };
  },
};

// Convenience array (projects that only want interaction tools)
export const interactionTools: ToolDefinition[] = [showUiTool];
