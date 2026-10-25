const VALID = new Set(['ask', 'tray', 'quit']);

export function resolveCloseAction({ preference, explicitQuit = false, trayAvailable = false } = {}) {
  if (explicitQuit) return 'quit';
  const action = VALID.has(preference) ? preference : 'ask';
  if (action === 'tray' && !trayAvailable) return 'ask';
  return action;
}
