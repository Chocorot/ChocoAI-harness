import { health } from '../../server/api.ts'

export const dynamic = 'force-dynamic'
export const GET = () => health()
