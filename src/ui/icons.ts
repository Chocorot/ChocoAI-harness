// The icon names the turn model uses (src/ui/lib/turn.ts TOOL_UI / ERROR_ICON) -> lucide icons. An unknown name falls back to a wrench.
import { AlertTriangle, CloudOff, Clock, FileText, Globe, Layers, ListChecks, Lock, Search, Sparkles, Terminal, Users, Wrench, type LucideIcon } from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  file: FileText, terminal: Terminal, globe: Globe, search: Search, users: Users, list: ListChecks, wrench: Wrench,
  clock: Clock, cloudoff: CloudOff, lock: Lock, layers: Layers, alert: AlertTriangle, sparkle: Sparkles,
}
export const iconFor = (name: string): LucideIcon => ICONS[name] ?? Wrench
