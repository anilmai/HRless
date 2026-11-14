import type { EngineInterface, Register } from 'claude-code'

// Starts the dashboard server (bundled in server/) detached, so it outlives this session,
// and opens it. A server already running answers the same port: the new one just opens the page and exits.
async function openDashboard($: EngineInterface) {
  const server = `${$.plugin.root}/server/server.js`.split(String.fromCharCode(92)).join('/')
  // The page opens on this session's own agent tree only.
  const session = (await $.session.id()).replace(/[^\w-]/g, '')
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = windows
    ? ['powershell', '-NoProfile', '-Command', `Start-Process -WindowStyle Hidden -FilePath node -ArgumentList '"${server}"','--open','--session','${session}'`]
    : ['sh', '-c', `nohup node '${server}' --open --session '${session}' >/dev/null 2>&1 &`]
  const { exitCode, stderr } = await $.process.run(argv)
  if (exitCode !== 0) $.ui.toast(`HRless açılamadı: ${stderr.trim().slice(0, 200) || 'node bulunamadı'}`)
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Other mods (Ponytail) share this slot: keep theirs under ours.
    const below = await next(e).catch(() => undefined)
    const { Box, Button } = $.ui.resolve(e)
    const mine = (
      <Box>
        <Button key="hrless" label="HRless" onPress={() => openDashboard($).catch(() => $.ui.toast('HRless açılamadı'))} />
      </Box>
    )
    return below ? <Box flexDirection="column">{mine}{below}</Box> : mine
  })
}
