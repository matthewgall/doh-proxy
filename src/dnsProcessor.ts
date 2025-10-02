import { toType, toRcode } from './dnsUtils';
import { DNSResponse, DNSAnswer, DNSQuestion } from './types';

export function processDNSResponse(decoded: any, providerUrl: string): DNSResponse {
	const response: DNSResponse = {
		Status: toRcode(decoded.rcode),
		Question: []
	};

	// Process flags
	for (const key of Object.keys(decoded)) {
		if (key.includes('flag_')) {
			const flagName = key.replace('flag_', '').toUpperCase();
			if (['AD', 'CD', 'RA', 'RD', 'TC'].includes(flagName)) {
				(response as any)[flagName] = decoded[key];
			}
		}
	}

	// Process questions
	for (const q of decoded.questions) {
		response.Question.push({
			name: `${q.name}.`,
			type: toType(q.type)
		});
	}

	// Process answers
	if (decoded.answers && decoded.answers.length > 0) {
		response.Answer = decoded.answers.map((ans: any): DNSAnswer => {
			const answer: DNSAnswer = {
				name: `${ans.name}.`,
				type: toType(ans.type),
				TTL: ans.ttl,
				data: ans.data
			};

			// Format specific record types
			switch (ans.type) {
				case 'DNSKEY':
					answer.data = `${ans.data.flags} ${ans.data.algorithm} ${btoa(String.fromCharCode.apply(null, ans.data.key))}`;
					break;
				case 'TXT':
					answer.data = ans.data[0].toString();
					break;
				case 'SRV':
					answer.data = `${ans.data.priority} ${ans.data.weight} ${ans.data.port} ${ans.data.target}.`;
					break;
				// Default: use data as-is
			}

			return answer;
		});
	} else {
		// Process authority records for negative responses
		response.Authority = decoded.authorities?.map((auth: any) => ({
			name: auth.name,
			type: toType(auth.type),
			TTL: auth.ttl,
			data: `${auth.data.mname}. ${auth.data.rname}. ${auth.data.serial} ${auth.data.refresh} ${auth.data.retry} ${auth.data.expire} ${auth.data.minimum}`
		})) || [];
	}

	// Add provider comment
	const hostname = new URL(providerUrl).hostname;
	response.Comment = `Response from ${hostname}`;

	return response;
}

export function extractProviderHostname(responseUrl: string): string {
	return new URL(responseUrl).hostname;
}