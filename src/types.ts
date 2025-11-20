// Core DNS Types
export interface DNSQuestion {
	name: string;
	type: number | string;
}

export interface DNSAnswer {
	name: string;
	type: number | string;
	TTL: number;
	data: string | any;
}

export interface DNSResponse {
	Status: number;
	TC?: boolean;
	RD?: boolean;
	RA?: boolean;
	AD?: boolean;
	CD?: boolean;
	Question: DNSQuestion[];
	Answer?: DNSAnswer[];
	Authority?: any[];
	Comment?: string;
}

// Analytics Types
export interface AnalyticsQueryResult {
	data?: any[];
	meta?: any;
	error?: string;
}

export interface HealthScore {
	[hostname: string]: number;
}

export interface HealthScoreResponse {
	family: string;
	last_updated: string;
	total_providers: number;
	data: Array<{
		provider: string;
		health_score: number;
	}>;
}

// Error Analytics Types
export interface ErrorAnalyticsResponse {
	queryType: string;
	hours: number;
	dataset: string;
	data?: any[];
	meta?: any;
	error?: string;
}

// Resolver Types
export interface WeightedResolver {
	resolver: string;
	weight: number;
}

export interface ResolverConfig {
	[family: string]: string;
}

// Environment Binding Types
// Extends the auto-generated Env interface from worker-configuration.d.ts
export interface CloudflareEnv extends Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_ACCOUNT_TOKEN: string;
}

// API Response Types
export interface APIError {
	error: string;
	message?: string;
	validTypes?: string[];
}