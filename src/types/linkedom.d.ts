declare module "linkedom" {
  export function parseHTML(html: string): {
    document: any;
    window: any;
  };
}

