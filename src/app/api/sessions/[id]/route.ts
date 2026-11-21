import { sessionDelete, sessionGet, sessionPatch } from '../../../../server/api.ts'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }
export const GET = async (req: Request, { params }: Ctx) => sessionGet(req, (await params).id)
export const PATCH = async (req: Request, { params }: Ctx) => sessionPatch(req, (await params).id)
export const DELETE = async (req: Request, { params }: Ctx) => sessionDelete(req, (await params).id)
