export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface StandardComplianceCheck {
  name: string;
  passed: boolean;
  score: number; // 0-100
  grade: Grade;
  severity: number; // 0-100
  explanation: string;
  details: Record<string, any>;
  recommendations: Recommendation[];
}

export interface Recommendation {
  issue: string;
  severity: number;
  suggestion: string;
}

export interface ApiComplianceResult {
  url: string;
  overallScore: number; // 0-100
  overallGrade: Grade;
  checks: StandardComplianceCheck[];
  recommendations: Recommendation[];
  checkedAt: string;
}

export interface ApiInfo {
  api: string;
  status: string;
  version: string;
  docs: ApiDocs;
  pricing: {
    pricePerCall: string;
    priceNumber: number;
    description: string;
  };
}

export interface ApiDocs {
  endpoints: EndpointDoc[];
  parameters: ParameterDoc[];
  examples: ExampleDoc[];
}

export interface EndpointDoc {
  method: string;
  path: string;
  description: string;
  parameters: ParameterDoc[];
  exampleResponse: any;
}

export interface ParameterDoc {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface ExampleDoc {
  summary: string;
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
  };
  response: any;
}
