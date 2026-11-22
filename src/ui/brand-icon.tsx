import { forwardRef } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

/**
 * The ChocoAI mark: a speech bubble with a four-point spark. The SAME drawing as the app icon, favicon and manifest icons
 * (`public/icons/mark.svg`, from the shared brand set in ChocoHost-Design `brand/`), so the logo inside the page matches the one on the tab and the
 * home screen. Shaped like a lucide icon, so `BrandMark` and the other lucide slots take it.
 */
export const ChocoAiMark: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(({ size = 24, strokeWidth = 2, className, ...rest }, ref) => (
  <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
    <path d="M6 3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-3.5L12 20.5 9.5 17H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" />
    <path d="M12 6.4Q12.43 9.57 15.6 10Q12.43 10.43 12 13.6Q11.57 10.43 8.4 10Q11.57 9.57 12 6.4Z" fill="currentColor" />
  </svg>
))
ChocoAiMark.displayName = 'ChocoAiMark'
