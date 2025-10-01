import Config from '../config.json';
import Resolvers from '../resolvers.json';

// Utility function to get all families from config.json
export function getAllFamilies() {
	let families = new Set<string>();
	for (let configKey of Object.keys(Config)) {
		if (configKey.includes('.mydns.network')) {
			let family = configKey.replace('.mydns.network', '');
			families.add(family);
		} else if (configKey === 'default') {
			families.add('freedom'); // default maps to freedom
		}
	}
	return Array.from(families).sort();
}

// Map family names to their resolver family equivalents  
// Paranoia uses freedom endpoints to avoid duplicate data in resolvers.json
export function getResolverFamily(family: string): string {
	return family === 'paranoia' ? 'freedom' : family;
}

// Utility function for random sampling
export function sampleArrayN<T>(array: T[], n: number): T[] {
	if (n >= array.length) return [...array];
	
	// Fisher-Yates shuffle for better randomness than sort()
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result.slice(0, n);
}