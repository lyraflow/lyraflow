// The SHAPE lives in core with the row it is part of (#125); resolving it --
// which needs a database and a request IP -- stays here.
export type { GeoInfo } from '@lyraflow/core'
import type { GeoInfo } from '@lyraflow/core'

// Frozen: this exact object is returned to every caller of resolve(). A
// mutable shared instance would let one caller's edit corrupt every
// subsequent event that flows through the null resolver.
export const EMPTY_GEO: GeoInfo = Object.freeze({ country: '', region: '', city: '' })

export interface GeoResolver {
  resolve(ip: string | undefined): GeoInfo
}

/**
 * Default resolver. Choosing a geo database whose licence permits
 * redistribution inside a fair-code product is an open item; until that is
 * settled, installs run without geo rather than blocking on it.
 */
export class NullGeoResolver implements GeoResolver {
  resolve(): GeoInfo {
    return EMPTY_GEO
  }
}
