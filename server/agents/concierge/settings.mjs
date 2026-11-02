/**
 * What the Support Concierge watches, read from the agent's own settings (private.agents.config).
 * The owner changes them with SQL only: the Team screen has no settings editor. A missing or
 * unusable value falls back to the default, so a typo can never switch triage on for a channel
 * nobody asked for.
 *
 * - channels: which conversations it looks at. Text messages stay off by default until the
 *   toll-free verification covers support texts.
 * - settle_seconds: how long after a message it waits, so a burst of texts is triaged once.
 * - window_hours: how old an unanswered message may be and still be triaged, so importing old
 *   history never triggers a backlog.
 */
const allChannels = ['phone', 'sms', 'email', 'chat', 'web_form'];
const whole = (value, low, high, fallback) => (Number.isInteger(value) && value >= low && value <= high ? value : fallback);

export function conciergeSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    channels: Array.isArray(source.channels) ? [...new Set(source.channels.filter(channel => allChannels.includes(channel)))] : ['email', 'chat', 'web_form', 'phone'],
    settleSeconds: whole(source.settle_seconds, 0, 3600, 90),
    windowHours: whole(source.window_hours, 1, 720, 72),
  };
}
