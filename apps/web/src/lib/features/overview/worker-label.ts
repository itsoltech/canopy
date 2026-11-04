/** Remove only Canopy's generated prefix and local DNS suffix; preserve custom names and host identity. */
export function workerLabel(name: string): string {
  return name.replace(/^Canopy\s*·\s*/, "").replace(/\.(home|local)$/i, "");
}
