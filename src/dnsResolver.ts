import { Buffer } from 'node:buffer';
import base64url from 'base64url';
import * as dnsPacket from '@dnsquery/dns-packet';
import Resolvers from '../resolvers.json';
import { sampleArrayN, getResolverFamily } from './utils';

export function getRandomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function getDNSResponse(url: string, env: any, family: string): Promise<Response> {
	const hostname = new URL(url).hostname;
	try {
		const response = await fetch(url, {
			headers: {
				'Content-Type': 'application/dns-message'
			}
		});

		if (response.status !== 200) {
			// Log non-200 response to Error Analytics Engine
			try {
				env.ERROR_ANALYTICS.writeDataPoint({
					'blobs': [hostname, `HTTP_${response.status}`], 
					'doubles': [response.status],
					'indexes': [family]
				});
			} catch (e) {
				// Ignore analytics errors
			}
			throw new Error(`HTTP ${response.status} from ${hostname}`);
		}
		return response;
	} catch (e: any) {
		// Log fetch errors to Analytics Engine
		let errorType = 'FETCH_ERROR';
		if (e.name === 'TypeError') errorType = 'NETWORK_ERROR';
		if (e.message.includes('timeout')) errorType = 'TIMEOUT_ERROR';
		if (e.message.includes('DNS')) errorType = 'DNS_ERROR';

		try {
			env.ERROR_ANALYTICS.writeDataPoint({
				'blobs': [hostname, errorType], 
				'doubles': [],
				'indexes': [family]
			});
		} catch (analyticsError) {
			// Ignore analytics errors
		}
		throw e;
	}
}

export function weightedSample(resolvers: string[], healthScores: any, family: string, n: number): string[] {
	// Calculate weights for each resolver
	const weightedResolvers = resolvers.map((r: string) => {
		const resolverUrl = Resolvers[r as keyof typeof Resolvers]?.[family as keyof typeof Resolvers[keyof typeof Resolvers]];
		if (!resolverUrl) return { resolver: r, weight: 0 };
		
		const hostname = new URL(resolverUrl as string).hostname;
		const health = healthScores[hostname] || 50; // Default health score
		
		return { resolver: r, weight: health };
	}).filter((wr: any) => wr.weight > 0);

	if (weightedResolvers.length === 0) return resolvers.slice(0, n);

	// Select n resolvers based on weighted probability
	const selected: string[] = [];
	let totalWeight = weightedResolvers.reduce((sum: number, wr: any) => sum + wr.weight, 0);

	for (let i = 0; i < Math.min(n, weightedResolvers.length); i++) {
		const random = Math.random() * totalWeight;
		let cumulative = 0;

		for (let j = 0; j < weightedResolvers.length; j++) {
			const wr = weightedResolvers[j];
			cumulative += wr.weight;
			if (random <= cumulative) {
				selected.push(wr.resolver);
				// Remove selected resolver to avoid duplicates
				weightedResolvers.splice(j, 1);
				totalWeight -= wr.weight;
				break;
			}
		}
	}

	return selected.length > 0 ? selected : resolvers.slice(0, n);
}

export async function chooseResolvers(
	resolvers: string[], 
	query: string, 
	family: string = "freedom", 
	n: number = 3, 
	env: any,
	getHealthScores: (env: any, family: string) => Promise<any>
): Promise<Response[]> {
	const promises: Promise<Response>[] = [];
	
	// Get current health scores
	const healthScores = await getHealthScores(env, family);
	
	// Select resolvers using weighted sampling based on health
	let selectedResolvers: string[];
	if (Object.keys(healthScores).length > 0) {
		selectedResolvers = weightedSample(resolvers, healthScores, family, n);
	} else {
		// Fallback to random selection if no health data
		selectedResolvers = resolvers.length > n ? sampleArrayN(resolvers, n) : resolvers;
	}
	
	// Create DNS requests for selected resolvers
	for (const r of selectedResolvers) {
		try {
			const resolverFamily = getResolverFamily(family);
			const resolverConfig = Resolvers[r as keyof typeof Resolvers];
			if (resolverConfig && (resolverConfig as any)[resolverFamily]) {
				const url = `${(resolverConfig as any)[resolverFamily]}?dns=${query}`;
				promises.push(getDNSResponse(url, env, family));
			}
		} catch (e) {
			// Ignore individual resolver errors
		}
	}

	return promises;
}

export function enforceDNSSEC(decodedQuery: any): any {
	// Enforce DNSSEC: ensure CD flag is NOT set
	decodedQuery.flags = decodedQuery.flags & ~dnsPacket.CHECKING_DISABLED; // Clear CD flag
	decodedQuery.flags = decodedQuery.flags | dnsPacket.RECURSION_DESIRED; // Ensure RD is set
	
	// Add minimal EDNS0 with DNSSEC_OK flag
	if (!decodedQuery.additionals) {
		decodedQuery.additionals = [];
	}
	
	decodedQuery.additionals.push({
		type: 'OPT',
		name: '.',
		class: 512, // Smaller UDP payload size
		flags: dnsPacket.DNSSEC_OK
	});
	
	return decodedQuery;
}

export function createDNSQuery(name: string, rrtype: string): string {
	const query = dnsPacket.encode({
		type: 'query',
		id: getRandomInt(1, 65534),
		flags: dnsPacket.RECURSION_DESIRED, // CD flag is NOT set, enforcing DNSSEC validation
		additionals: [{
			type: 'OPT',
			name: '.',
			class: 4096, // UDP payload size is set via class field for OPT records
			flags: dnsPacket.DNSSEC_OK // Request DNSSEC records
		}],
		questions: [{
			type: rrtype,
			name: name
		}]
	});
	return base64url(query);
}