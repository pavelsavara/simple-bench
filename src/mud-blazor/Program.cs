using System;
using System.Net.Http;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MudBlazor.Docs.Extensions;
using MudBlazor.Docs.Models;
using MudBlazor.Docs.Services.Notifications;

var builder = WebAssemblyHostBuilder.CreateDefault(args);

builder.RootComponents.Add<MudBlazor.Docs.App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(_ => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.TryAddDocsViewServices();

var build = builder.Build();

var notificationService = build.Services.GetService<INotificationService>();
if (notificationService is InMemoryNotificationService inMemoryService)
{
    inMemoryService.Preload();
}

// Warm up the documentation
ApiDocumentation.GetType("MudAlert");

await build.RunAsync();
