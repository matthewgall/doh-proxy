import Config from '../config.json';
import { getResolverFamily } from './utils';

export interface RequestContext {
	hostname: string;
	family: string;
	resolverFamily: string;
	resolvers: string[];
	dataset: string;
	configKey: string;
}

export function parseRequestContext(url: URL): RequestContext {
	// Extract hostname and family
	let family = "freedom";
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}

	// Determine resolver family (handles paranoia→freedom mapping)
	const resolverFamily = getResolverFamily(family);

	// Map staging hostnames to production config keys
	let configKey = url.hostname;
	if (url.hostname.includes('.staging.mydns.network')) {
		configKey = url.hostname.replace('.staging.mydns.network', '.mydns.network');
	}

	// Get resolvers for this hostname/family
	let resolvers = Config['default'].resolvers;
	if (Config[configKey as keyof typeof Config]) {
		resolvers = Config[configKey as keyof typeof Config].resolvers;
	}

	// Determine dataset (prod/dev)
	const dataset = url.hostname.includes('.staging.') ? 'dev' : 'prod';

	return {
		hostname: url.hostname,
		family,
		resolverFamily,
		resolvers,
		dataset,
		configKey
	};
}

export function validateDNSQueryType(rrtype: string): boolean {
	return ['A', 'AAAA', 'DNSKEY', 'MX', 'NS', 'SRV', 'TXT'].includes(rrtype);
}

export function parseQueryParameters(url: URL): { name?: string; type: string } {
	const searchParams = url.searchParams;
	const name = searchParams.get('name') || undefined;
	
	let type = 'A';
	const typeParam = searchParams.get('type');
	if (typeParam) {
		type = Array.isArray(typeParam) ? typeParam[0] : typeParam;
		type = type.toUpperCase();
	}

	return { name, type };
}