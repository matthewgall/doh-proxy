import Config from '../config.json';
import Resolvers from '../resolvers.json';
import { getAllFamilies } from './utils';

export async function updateResolverHealthScores(env: any): Promise<void> {
	const dataset = env.ANALYTICS.toString().includes('dev') ? 'dev' : 'prod';
	
	try {
		// Start with all configured resolvers at perfect health (100)
		const healthScores: Record<string, number> = {};
		
		// Get all unique resolvers across all families from config
		for (const configKey of Object.keys(Config)) {
			const configResolvers = Config[configKey as keyof typeof Config].resolvers;
			for (const resolverKey of configResolvers) {
				const resolverConfig = Resolvers[resolverKey as keyof typeof Resolvers];
				if (resolverConfig) {
					// Check all available families for this resolver
					for (const family of getAllFamilies()) {
						if ((resolverConfig as any)[family]) {
							const hostname = new URL((resolverConfig as any)[family]).hostname;
							healthScores[hostname] = 100; // Start at perfect health
						}
					}
				}
			}
		}
		
		// Query error counts and success counts to calculate error rates
		const errorQuery = `SELECT blob1 AS provider, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '2' HOUR GROUP BY provider;`;
		const successQuery = `SELECT blob1 AS provider, SUM(_sample_interval) AS success_count FROM 'mydnsproxy-${dataset}' WHERE timestamp > NOW() - INTERVAL '2' HOUR GROUP BY provider;`;
		
		// Get error data
		const errorData: Record<string, number> = {};
		try {
			const errorResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
				method: 'POST',
				body: errorQuery,
				headers: {
					'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
				}
			});
			
			if (errorResponse.status === 200) {
				const data = await errorResponse.json();
				for (const row of (data as any).data) {
					errorData[row.provider] = parseInt(row.error_count);
				}
			}
		} catch (e) {
			console.log('Failed to get error data:', e);
		}
		
		// Get success data
		const successData: Record<string, number> = {};
		try {
			const successResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
				method: 'POST',
				body: successQuery,
				headers: {
					'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
				}
			});
			
			if (successResponse.status === 200) {
				const data = await successResponse.json();
				for (const row of (data as any).data) {
					successData[row.provider] = parseInt(row.success_count);
				}
			}
		} catch (e) {
			console.log('Failed to get success data:', e);
		}
		
		// Calculate error rates and adjust health scores
		for (const provider in healthScores) {
			const errors = errorData[provider] || 0;
			const successes = successData[provider] || 0;
			const totalRequests = errors + successes;
			
			if (totalRequests > 0) {
				const errorRate = errors / totalRequests;
				// Health score: 100 * (1 - error_rate), minimum 1
				// 0% error rate = 100, 1% error rate = 99, 10% error rate = 90, etc.
				healthScores[provider] = Math.max(1, Math.round(100 * (1 - errorRate)));
			}
			// If no data, keep default score of 100
		}
		
		// Store single combined health scores in KV with 10 minute TTL
		await env.RESOLVER_HEALTH.put('health-scores', JSON.stringify(healthScores), {
			expirationTtl: 600 // 10 minutes
		});
		
		console.log(`Updated combined health scores:`, Object.keys(healthScores).length, 'providers');
	} catch (e) {
		console.log(`Failed to update health scores:`, e);
	}
}

export async function getResolverHealthScores(env: any, family: string): Promise<Record<string, number>> {
	try {
		// Fast KV lookup - single combined health scores for all families
		const healthData = await env.RESOLVER_HEALTH.get('health-scores', 'json');
		return healthData || {};
	} catch (e) {
		console.log(`Failed to get health scores:`, e);
		return {};
	}
}

export async function executeAnalyticsQuery(query: string, env: any): Promise<any> {
	try {
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
			method: 'POST',
			body: query,
			headers: {
				'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
			}
		});

		if (response.status !== 200) {
			return { error: `Analytics API returned ${response.status}` };
		}

		const data = await response.json();
		return { data: data.data, meta: data.meta };
	} catch (e: any) {
		return { error: e.message };
	}
}

export function buildAnalyticsQuery(queryType: string, hours: number, dataset: string): string {
	switch (queryType) {
		case 'error-rates':
			return `SELECT blob1 AS provider, blob2 AS error_type, index1 AS resolver_family, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, error_type, resolver_family ORDER BY error_count DESC;`;
		
		case 'http-errors':
			return `SELECT blob1 AS provider, blob2 AS error_type, double1 AS http_status, COUNT() AS occurrences FROM 'mydnsproxy-errors-${dataset}' WHERE blob2 LIKE 'HTTP_%' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, error_type, http_status ORDER BY occurrences DESC;`;
		
		case 'reliability':
			return `SELECT blob1 AS provider, index1 AS resolver_family, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, resolver_family ORDER BY error_count DESC;`;
		
		case 'error-types':
			return `SELECT blob1 AS provider, CASE WHEN blob2 = 'NETWORK_ERROR' THEN 'Network Issues' WHEN blob2 = 'TIMEOUT_ERROR' THEN 'Timeout Issues' WHEN blob2 LIKE 'HTTP_%' THEN 'HTTP Errors' WHEN blob2 = 'DNS_ERROR' THEN 'DNS Resolution' ELSE 'Other' END AS issue_category, COUNT() AS count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, issue_category ORDER BY provider, count DESC;`;
		
		case 'combined-health':
			return `SELECT blob1 AS provider, COUNT() AS total_errors FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider ORDER BY total_errors DESC;`;
		
		default:
			throw new Error('Invalid query type');
	}
}

export function logUsageAnalytics(env: any, provider: string, family: string): void {
	try {
		env.ANALYTICS.writeDataPoint({
			'blobs': [provider],
			'doubles': [],
			'indexes': [family]
		});
	} catch (e) {
		// Ignore analytics errors
	}
}