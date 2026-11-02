import { useColorScheme, StyleSheet } from 'react-native';

const light = { background: '#FAFAF9', surface: '#FFFFFF', inset: '#F0F2EE', text: '#18271F', muted: '#57675D', line: '#1C33221A', accent: '#286342', onAccent: '#FFFFFF', softAccent: '#E5F0E7', warning: '#916015', danger: '#AC3535' };
const dark = { background: '#121614', surface: '#1A211D', inset: '#232C26', text: '#E7EEE9', muted: '#A1B2A6', line: '#E0F4E51A', accent: '#91C9A0', onAccent: '#142A1B', softAccent: '#263D2D', warning: '#E7BB72', danger: '#F19898' };
export type Colors = typeof light;
export function useColors() { return useColorScheme() === 'dark' ? dark : light; }
export const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 24, gap: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 32, fontWeight: '600', letterSpacing: -0.8 },
  heading: { fontSize: 20, fontWeight: '600', letterSpacing: -0.3 },
  body: { fontSize: 16, lineHeight: 25 },
  label: { fontSize: 16, fontWeight: '500' },
  meta: { fontSize: 14, lineHeight: 21 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 13, fontSize: 16, minHeight: 48 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
});
