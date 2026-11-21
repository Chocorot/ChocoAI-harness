import { uploadGet } from '../../../../../../server/api.ts'

export const dynamic = 'force-dynamic'
export const GET = async (req: Request, { params }: { params: Promise<{ id: string; name: string }> }) => {
  const p = await params
  return uploadGet(req, p.id, p.name)
}
