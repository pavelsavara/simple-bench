namespace Try.Core
{
    using System;
    using System.Collections.Generic;
    using Microsoft.CodeAnalysis;

    public class CompileToAssemblyResult
    {
        public Compilation Compilation { get; set; }

        public IEnumerable<CompilationDiagnostic> Diagnostics { get; set; } = Array.Empty<CompilationDiagnostic>();

        public byte[] AssemblyBytes { get; set; }
    }
}
