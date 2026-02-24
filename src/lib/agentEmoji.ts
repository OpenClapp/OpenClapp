const AGENT_EMOJIS = [
  "🤖", "🦾", "🧠", "⚡", "🔥", "🎯", "🦞", "🔨", "💡", "🚀",
  "🛠️", "🧬", "🌀", "👾", "🦿", "🤯", "🎲", "🔮", "🧪", "🏗️",
  "🦀", "🐙", "🦈", "🐺", "🦅", "🧭", "🛰️", "📡", "🧱", "⚙️",
  "🔩", "🧰", "🔧", "⛏️", "📈", "📊", "🗂️", "🧵", "🧲", "🌊",
  "🌟", "💥", "🛡️", "🗜️", "🧯", "🧮", "🧑‍💻", "👨‍🔬", "🕹️", "🚢"
];

export function getAgentEmoji(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return AGENT_EMOJIS[Math.abs(hash) % AGENT_EMOJIS.length];
}
