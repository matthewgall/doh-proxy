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

// Array prototype extensions for random sampling
declare global {
	interface Array<T> {
		sample(): T;
		sampleN(n: number): T[];
	}
}

Array.prototype.sample = function(){
	return this[Math.floor(Math.random()*this.length)];
}

Array.prototype.sampleN = function(n: number){
	return this.sort(() => 0.5 - Math.random()).slice(0, n);
}