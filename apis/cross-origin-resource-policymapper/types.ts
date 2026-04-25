export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface CorsHeaderAnalysis {
  header: string;
  present: boolean;
  value: string | null;
  issues: string[];
  severityScore: number; // 0-100
  grade: Grade;
}

export interface EndpointCorsAnalysis {
  url: string;
  corsHeaders: Record<string, CorsHeaderAnalysis>;
  overallScore: number; // 0-100
  grade: Grade;
  explanation: string;
  recommendations: Recommendation[];
  fetchedAt: string;
}

export interface AggregatedCorsReport {
  baseUrl: string;
  endpointCount: number;
  averageScore: number;
  overallGrade: Grade;
  summary: {
    overlyPermissiveCount: number;
    misconfigurationCount: number;
    inconsistentHeaders: string[];
  };
  endpoints: EndpointCorsAnalysis[];
  recommendations: Recommendation[];
  generatedAt: string;
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface UrlListRequest {
  baseUrl: string; // base URL to scan (e.g. https://example.com)
  endpoints?: string[]; // optional array of endpoint paths or full URLs to test
}
