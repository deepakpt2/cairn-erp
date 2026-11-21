// Verifies the end-user docs in docs/ against the app: relative Markdown links
// resolve, anchors exist, and every backticked /route names a real page.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const docsDir = path.join(root, 'docs')
const appDir = path.join(root, 'src', 'app')
const SECTIONS = /^(0\d-|README\.md$)/

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// Routes: every page.tsx under src/app; (groups) dropped, [param] kept as wildcard.
const routes = walk(appDir)
  .filter((f) => /\/page\.tsx$/.test(f))
  .map((f) => '/' + path.relative(appDir, path.dirname(f)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).join('/'))
  .map((r) => (r === '/.' ? '/' : r))
const routeRes = routes.map((r) => new RegExp('^' + r.replace(/(\/\[\[\.\.\.[^\]]+\]\])$/, '(?:/.*)?').replace(/\[[^\]]+\]/g, '[^/]+') + '$'))
const routeOk = (p) => routeRes.some((re) => re.test(p))

const slug = (h) =>
  h.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')

const files = walk(docsDir).filter((f) => f.endsWith('.md') && SECTIONS.test(path.relative(docsDir, f)))
const problems = []

for (const f of files) {
  const rel = path.relative(root, f)
  const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '')
  const anchors = (file) => {
    const t = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
    return new Set([...t.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])))
  }
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]
    if (/^(https?:|mailto:)/.test(href)) continue
    const [file, anchor] = href.split('#')
    const target = file ? path.resolve(path.dirname(f), file) : f
    if (!fs.existsSync(target)) { problems.push(`${rel}: dead link ${href}`); continue }
    if (anchor && target.endsWith('.md') && !anchors(target).has(anchor))
      problems.push(`${rel}: missing anchor ${href}`)
  }
  for (const m of text.matchAll(/`(\/[a-z0-9][a-z0-9\-/\[\]]*)`/g)) {
    const p = m[1]
    if (!routeOk(p) && !routeOk(p.replace(/\/$/, ''))) problems.push(`${rel}: no page for route ${p}`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\n${problems.length} problem(s) in ${files.length} file(s)`)
  process.exit(1)
}
console.log(`docs OK: ${files.length} files, ${routes.length} routes known`)
