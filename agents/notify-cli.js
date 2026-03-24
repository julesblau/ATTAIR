#!/usr/bin/env node
/**
 * CLI wrapper for notify.js — lets agents call notification functions via Bash.
 *
 * Usage:
 *   node notify-cli.js ask "Should we remove light mode or fix it?" ["optional context"]
 *   node notify-cli.js notify "Backend agent finished. Starting UI/UX agent now."
 *   node notify-cli.js followup 5 "Got it — one more question: dark or light theme?"
 *   node notify-cli.js close 5 "All done, moving on."
 *   node notify-cli.js reply 5    — poll issue #5 for a human reply
 */

import { askHuman, notifyHuman, pollForReply, followUp, closeThread } from "./notify.js";

const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case "ask": {
      const question = args[0];
      if (!question) { console.error("Usage: notify-cli.js ask <question> [context]"); process.exit(1); }
      const context = args[1] || "";
      const { reply, issueNum } = await askHuman(question, { context, timeoutMs: 4 * 60 * 60 * 1000 });
      if (reply) {
        console.log(`ISSUE_NUM: ${issueNum}`);
        console.log(`HUMAN_REPLY: ${reply}`);
      } else {
        console.log(`ISSUE_NUM: ${issueNum}`);
        console.log("HUMAN_REPLY: [timed out — no reply received]");
      }
      break;
    }
    case "followup": {
      const issueNum = parseInt(args[0], 10);
      const message = args[1];
      if (!issueNum || !message) { console.error("Usage: notify-cli.js followup <issue-number> <message>"); process.exit(1); }
      const reply = await followUp(issueNum, message);
      if (reply) {
        console.log(`HUMAN_REPLY: ${reply}`);
      } else {
        console.log("HUMAN_REPLY: [timed out]");
      }
      break;
    }
    case "close": {
      const issueNum = parseInt(args[0], 10);
      if (!issueNum) { console.error("Usage: notify-cli.js close <issue-number> [summary]"); process.exit(1); }
      closeThread(issueNum, args[1] || "");
      console.log(`CLOSED: issue #${issueNum}`);
      break;
    }
    case "notify": {
      const message = args[0];
      if (!message) { console.error("Usage: notify-cli.js notify <message>"); process.exit(1); }
      const issueNum = notifyHuman(message, { title: args[1] });
      console.log(`NOTIFIED: issue #${issueNum}`);
      break;
    }
    case "reply": {
      const issueNum = parseInt(args[0], 10);
      if (!issueNum) { console.error("Usage: notify-cli.js reply <issue-number>"); process.exit(1); }
      const reply = await pollForReply(issueNum);
      if (reply) {
        console.log(`HUMAN_REPLY: ${reply}`);
      } else {
        console.log("HUMAN_REPLY: [timed out]");
      }
      break;
    }
    default:
      console.error("Unknown command. Use: ask, notify, followup, close, or reply");
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
