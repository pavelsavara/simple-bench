# Blazing Pizza — Smoke Test Walkthrough

Playwright smoke test sequence that visits every page and exercises all major interactive elements.
Uses `data-testid` selectors added to the source code.

## Selector Reference

| Element | Selector | Page/Component |
|---|---|---|
| Top bar | `[data-testid="top-bar"]` | MainLayout |
| Logo link | `[data-testid="logo-link"]` | MainLayout |
| Get Pizza nav tab | `[data-testid="nav-get-pizza"]` | MainLayout |
| My Orders nav tab | `[data-testid="nav-my-orders"]` | MainLayout |
| Pizza cards container | `[data-testid="pizza-cards"]` | Home |
| Pizza special N | `[data-testid="pizza-special-{id}"]` | Home (ids: 1–8) |
| Empty cart | `[data-testid="empty-cart"]` | Home |
| Order contents | `[data-testid="order-contents"]` | Home |
| Order total bar | `[data-testid="order-total"]` | Home |
| Total price | `[data-testid="total-price"]` | Home |
| Order > button | `[data-testid="order-button"]` | Home |
| Sidebar | `[data-testid="sidebar"]` | Home |
| Dialog container | `[data-testid="dialog-container"]` | TemplatedDialog |
| Dialog title | `[data-testid="configure-dialog-title"]` | ConfigurePizzaDialog |
| Size slider | `[data-testid="size-slider"]` | ConfigurePizzaDialog |
| Size label | `[data-testid="size-label"]` | ConfigurePizzaDialog |
| Topping select | `[data-testid="topping-select"]` | ConfigurePizzaDialog |
| Remove topping | `[data-testid="remove-topping"]` | ConfigurePizzaDialog |
| Cancel button | `[data-testid="cancel-button"]` | ConfigurePizzaDialog |
| Confirm pizza (Order >) | `[data-testid="confirm-pizza-button"]` | ConfigurePizzaDialog |
| Dialog price | `[data-testid="dialog-price"]` | ConfigurePizzaDialog |
| Cart item | `[data-testid="cart-item"]` | ConfiguredPizzaItem |
| Remove pizza (x) | `[data-testid="remove-pizza"]` | ConfiguredPizzaItem |
| Checkout main | `[data-testid="checkout-main"]` | Checkout |
| Order details area | `[data-testid="checkout-order-details"]` | Checkout |
| Delivery address area | `[data-testid="checkout-delivery-address"]` | Checkout |
| Place order button | `[data-testid="place-order-button"]` | Checkout |
| Address: Name | `[data-testid="address-name"]` | AddressEditor |
| Address: Line 1 | `[data-testid="address-line1"]` | AddressEditor |
| Address: Line 2 | `[data-testid="address-line2"]` | AddressEditor |
| Address: City | `[data-testid="address-city"]` | AddressEditor |
| Address: Region | `[data-testid="address-region"]` | AddressEditor |
| Address: Postal Code | `[data-testid="address-postalcode"]` | AddressEditor |
| My Orders main | `[data-testid="myorders-main"]` | MyOrders |
| "Order some pizza" link | `[data-testid="order-some-pizza-link"]` | MyOrders (empty state) |
| Order list item | `[data-testid="order-list-item"]` | TemplatedList |
| Track order N | `[data-testid="track-order-{id}"]` | MyOrders |
| Track order container | `[data-testid="track-order"]` | OrderDetails |
| Track order title | `[data-testid="track-order-title"]` | OrderDetails |
| Order status text | `[data-testid="order-status"]` | OrderDetails |
| Map area | `[data-testid="track-order-map"]` | OrderDetails |

## Test Sequence

### Step 0 — App loads

- Navigate to base URL `/`
- **Wait** for `[data-testid="pizza-cards"]` to be visible
- **Assert** `[data-testid="top-bar"]` is visible
- **Assert** `[data-testid="nav-get-pizza"]` is visible (active class)
- **Assert** `[data-testid="nav-my-orders"]` is visible (user is auto-authenticated)
- **Assert** `.username` text is `demo@blazingpizza.com`
- **Assert** 8 pizza specials rendered: `[data-testid^="pizza-special-"]` count = 8
- **Assert** `[data-testid="empty-cart"]` is visible (`Choose a pizza to get started`)
- **Assert** `[data-testid="order-button"]` has class `disabled`

### Step 1 — Open pizza config dialog, then cancel

- **Click** `[data-testid="pizza-special-1"]` (Basic Cheese Pizza)
- **Wait** for `[data-testid="dialog-container"]` to be visible
- **Assert** `[data-testid="configure-dialog-title"]` contains text `Basic Cheese Pizza`
- **Assert** `[data-testid="size-slider"]` value is `12` (default)
- **Assert** `[data-testid="topping-select"]` is visible
- **Click** `[data-testid="cancel-button"]`
- **Wait** for `[data-testid="dialog-container"]` to be hidden
- **Assert** `[data-testid="empty-cart"]` is still visible (nothing added)

### Step 2 — Configure first pizza with toppings

- **Click** `[data-testid="pizza-special-2"]` (The Baconatorizor)
- **Wait** for `[data-testid="dialog-container"]` to be visible
- **Assert** dialog title contains `The Baconatorizor`
- **Drag/set** `[data-testid="size-slider"]` to value `15` (large)
- **Assert** `[data-testid="size-label"]` contains `15"`
- **Select** option index `0` from `[data-testid="topping-select"]` (first available topping)
- **Assert** at least one `.topping` div appears in `[data-testid="configure-dialog-body"]`
- **Select** another topping from `[data-testid="topping-select"]`
- **Assert** `.topping` count is 2
- **Click** first `[data-testid="remove-topping"]` button
- **Assert** `.topping` count is back to 1
- **Click** `[data-testid="confirm-pizza-button"]`
- **Wait** for `[data-testid="dialog-container"]` to be hidden
- **Assert** `[data-testid="empty-cart"]` is NOT visible
- **Assert** `[data-testid="order-contents"]` is visible
- **Assert** `[data-testid="cart-item"]` count = 1
- **Assert** `[data-testid="order-button"]` does NOT have class `disabled`
- **Assert** `[data-testid="total-price"]` is not empty

### Step 3 — Add a second pizza (quick, no topping changes)

- **Click** `[data-testid="pizza-special-8"]` (Margherita)
- **Wait** for `[data-testid="dialog-container"]` to be visible
- **Click** `[data-testid="confirm-pizza-button"]` (accept defaults)
- **Wait** for `[data-testid="dialog-container"]` to be hidden
- **Assert** `[data-testid="cart-item"]` count = 2

### Step 4 — Remove a pizza from the cart

- **Click** first `[data-testid="remove-pizza"]` (triggers JS confirm dialog)
- **Handle** browser confirm dialog: accept
- **Assert** `[data-testid="cart-item"]` count = 1

### Step 5 — Navigate to checkout

- **Click** `[data-testid="order-button"]`
- **Wait** for `[data-testid="checkout-main"]` to be visible
- **Assert** URL contains `/checkout`
- **Assert** `[data-testid="checkout-order-details"]` is visible
- **Assert** `[data-testid="checkout-delivery-address"]` is visible
- **Assert** `[data-testid="place-order-button"]` is visible

### Step 6 — Submit checkout with validation errors

- **Click** `[data-testid="place-order-button"]` (form is empty → validation fires)
- **Assert** `.validation-message` elements appear (required field errors)

### Step 7 — Fill delivery address and place order

- **Fill** `[data-testid="address-name"]` → `Test User`
- **Fill** `[data-testid="address-line1"]` → `123 Pizza Street`
- **Fill** `[data-testid="address-line2"]` → `Suite 4`
- **Fill** `[data-testid="address-city"]` → `London`
- **Fill** `[data-testid="address-region"]` → `Greater London`
- **Fill** `[data-testid="address-postalcode"]` → `EC1A 1BB`
- **Click** `[data-testid="place-order-button"]`
- **Wait** for URL to match `/myorders/\d+`

### Step 8 — Order tracking page

- **Assert** `[data-testid="track-order"]` is visible
- **Assert** `[data-testid="track-order-title"]` contains `Order placed`
- **Assert** `[data-testid="order-status"]` text is one of: `Preparing`, `Out for delivery`, `Delivered`
- **Assert** `[data-testid="track-order-map"]` is visible
- **Wait** 5 seconds for status poll to update at least once

### Step 9 — Navigate to My Orders list

- **Click** `[data-testid="nav-my-orders"]`
- **Wait** for `[data-testid="myorders-main"]` to be visible
- **Assert** URL is `/myorders`
- **Assert** `[data-testid="order-list-item"]` count >= 1
- **Assert** first `[data-testid="order-list-item"]` contains text `Items:` and `Total price:`

### Step 10 — Track an order from the list

- **Click** `[data-testid="track-order-1"]` (first order)
- **Wait** for `[data-testid="track-order"]` to be visible
- **Assert** URL matches `/myorders/1`
- **Assert** `[data-testid="order-status"]` is visible

### Step 11 — Navigate back home via nav

- **Click** `[data-testid="nav-get-pizza"]`
- **Wait** for `[data-testid="pizza-cards"]` to be visible
- **Assert** URL is `/`
- **Assert** `[data-testid="empty-cart"]` is visible (order was placed, cart reset)

### Step 12 — Navigate via logo

- **Click** `[data-testid="pizza-special-3"]` (Classic pepperoni)
- **Wait** for `[data-testid="dialog-container"]` to be visible
- **Click** `[data-testid="confirm-pizza-button"]`
- **Wait** for `[data-testid="dialog-container"]` to be hidden
- **Click** `[data-testid="logo-link"]`
- **Wait** for `[data-testid="pizza-cards"]` to be visible

## Coverage Summary

| Area | Covered |
|---|---|
| Home page — pizza listing | Yes (8 specials displayed) |
| Configure dialog — open/cancel | Yes (Step 1) |
| Configure dialog — resize slider | Yes (Step 2) |
| Configure dialog — add toppings | Yes (Step 2) |
| Configure dialog — remove topping | Yes (Step 2) |
| Configure dialog — confirm | Yes (Steps 2, 3) |
| Cart sidebar — items display | Yes (Steps 2–4) |
| Cart sidebar — remove pizza (JS confirm) | Yes (Step 4) |
| Cart — disabled order button (empty) | Yes (Step 0) |
| Cart — enabled order button | Yes (Step 2) |
| Checkout — validation errors | Yes (Step 6) |
| Checkout — fill address form (all 6 fields) | Yes (Step 7) |
| Checkout — place order | Yes (Step 7) |
| Order tracking — status display | Yes (Step 8) |
| Order tracking — map | Yes (Step 8) |
| Order tracking — polling | Yes (Step 8) |
| My Orders — order list | Yes (Step 9) |
| My Orders — track link | Yes (Step 10) |
| Navigation — Get Pizza tab | Yes (Step 11) |
| Navigation — My Orders tab | Yes (Step 9) |
| Navigation — Logo link | Yes (Step 12) |
| Auth — auto-login display | Yes (Step 0) |
