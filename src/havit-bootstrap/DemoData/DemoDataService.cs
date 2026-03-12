namespace Havit.Blazor.Documentation.DemoData;

public partial class DemoDataService : IDemoDataService
{
	private readonly ILogger<DemoDataService> _logger;

	private readonly List<EmployeeDto> _employees;

	public DemoDataService(ILogger<DemoDataService> logger)
	{
		_logger = logger;
		_employees = GenerateEmployees();
	}

	public IEnumerable<EmployeeDto> GetAllEmployees()
	{
		_logger.LogInformation("DemoDataService.GetAllEmployees() called.");
		return _employees.ToList();
	}

	public async Task<IEnumerable<EmployeeDto>> GetAllEmployeesAsync(CancellationToken cancellationToken = default)
	{
		_logger.LogInformation("DemoDataService.GetAllEmployeesAsync() called.");

		await Task.Delay(150, cancellationToken); // simulate server call

		return _employees.ToList();
	}

	public IQueryable<EmployeeDto> GetEmployeesAsQueryable()
	{
		_logger.LogInformation("DemoDataService.GetEmployeesAsQueryable() called.");
		return _employees.AsQueryable();
	}

	public async Task<DataFragmentResult<EmployeeDto>> GetEmployeesDataFragmentAsync(int startIndex, int? count, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.GetEmployeesDataFragmentAsync(startIndex: {startIndex}, count: {count}) called.");

		await Task.Delay(80, cancellationToken); // simulate server call
		return new()
		{
			Data = _employees.Skip(startIndex).Take(count ?? Int32.MaxValue).ToList(),
			TotalCount = _employees.Count
		};
	}


	public async Task<DataFragmentResult<EmployeeDto>> GetEmployeesDataFragmentAsync(EmployeesFilterDto filter, int startIndex, int? count, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.GetEmployeesDataFragmentAsync(startIndex: {startIndex}, count: {count}) called.");

		await Task.Delay(80, cancellationToken); // simulate server call

		IEnumerable<EmployeeDto> filteredEmployees = GetFilteredEmployees(filter);
		var data = filteredEmployees.Skip(startIndex).Take(count ?? Int32.MaxValue).ToList();
		return new()
		{
			Data = data,
			TotalCount = filteredEmployees.Count()
		};
	}

	private IEnumerable<EmployeeDto> GetFilteredEmployees(EmployeesFilterDto filter)
	{
		IEnumerable<EmployeeDto> result = _employees;
		if (!String.IsNullOrWhiteSpace(filter.Name))
			result = result.Where(e => e.Name.Contains(filter.Name, StringComparison.CurrentCultureIgnoreCase));
		if (!String.IsNullOrWhiteSpace(filter.Phone))
			result = result.Where(e => e.Phone.Contains(filter.Phone, StringComparison.CurrentCultureIgnoreCase));
		if (filter.SalaryMin.HasValue)
			result = result.Where(e => e.Salary >= filter.SalaryMin);
		if (filter.SalaryMax.HasValue)
			result = result.Where(e => e.Salary <= filter.SalaryMax);
		if (!String.IsNullOrWhiteSpace(filter.Position))
			result = result.Where(e => e.Position.Contains(filter.Position, StringComparison.CurrentCultureIgnoreCase));
		if (!String.IsNullOrWhiteSpace(filter.Location))
			result = result.Where(e => e.Location.Contains(filter.Location, StringComparison.CurrentCultureIgnoreCase));
		return result;
	}

	public async Task<int> GetEmployeesCountAsync(CancellationToken cancellationToken = default)
	{
		_logger.LogInformation("DemoDataService.GetEmployeesCountAsync(..) called.");

		try
		{
			await Task.Delay(80, cancellationToken); // simulate server call
		}
		catch (TaskCanceledException)
		{
			_logger.LogInformation("DemoDataService.GetEmployeesCountAsync(..) canceled.");
			throw;
		}

		return _employees.Count;
	}

	public async Task<int> GetEmployeesCountAsync(EmployeesFilterDto filter, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation("DemoDataService.GetEmployeesCountAsync(..) called.");

		try
		{
			await Task.Delay(80, cancellationToken); // simulate server call
		}
		catch (TaskCanceledException)
		{
			_logger.LogInformation("DemoDataService.GetEmployeesCountAsync(..) canceled.");
			throw;
		}

		return GetFilteredEmployees(filter).Count();
	}

	public async Task<List<EmployeeDto>> FindEmployeesByNameAsync(string query, int? limitCount = null, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.FindEmployeesByNameAsync(\"{query}\", {limitCount}) called.");

		try
		{
			await Task.Delay(180, cancellationToken); // simulate server call
		}
		catch (TaskCanceledException)
		{
			_logger.LogInformation($"DemoDataService.FindEmployeesByNameAsync(\"{query}\") canceled.");
			throw;
		}

		return _employees
			.Where(e => e.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase))
			.OrderBy(e => e.Name)
			.Take(limitCount ?? Int32.MaxValue)
			.ToList();
	}

	public async Task<EmployeeDto> GetEmployeeByIdAsync(int employeeId, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.GetEmployeeByIdAsync(\"{employeeId}\") called.");

		await Task.Delay(80, cancellationToken); // simulate server call

		return _employees.FirstOrDefault(e => e.Id == employeeId);
	}

	public async Task<List<EmployeeDto>> GetPreferredEmployeesAsync(int count, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.GetPreferredEmployeesAsync({count}) called.");

		await Task.Delay(80, cancellationToken); // simulate server call

		return _employees.OrderByDescending(e => e.Id).Take(count).ToList();
	}

	public async Task DeleteEmployeeAsync(int employeeId, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.DeleteEmployeeAsync(\"{employeeId}\") called.");

		await Task.Delay(80, cancellationToken); // simulate server call

		_employees.RemoveAll(e => e.Id == employeeId);
	}

	public async Task UpdateEmployeeAsync(EmployeeDto employee, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.UpdateEmployee(\"{employee.Id}\") called.");

		// simulate server call
		await Task.Delay(120, cancellationToken);

		var existingEmployee = _employees.FirstOrDefault(e => e.Id == employee.Id)
			?? throw new InvalidOperationException($"Employee with ID {employee.Id} not found.");

		existingEmployee.Name = employee.Name;
		existingEmployee.Email = employee.Email;
		existingEmployee.Phone = employee.Phone;
		existingEmployee.Salary = employee.Salary;
		existingEmployee.Position = employee.Position;
		existingEmployee.Location = employee.Location;
	}

	public async Task<int> CreateNewEmployeeAsync(EmployeeDto employee, CancellationToken cancellationToken = default)
	{
		_logger.LogInformation($"DemoDataService.CreateNewEmployeeAsync() called.");
		ArgumentOutOfRangeException.ThrowIfNotEqual(employee.Id, 0);

		// simulate server call
		await Task.Delay(140, cancellationToken);

		var newEmployee = employee with { Id = _employees.Max(e => e.Id) + 1 };
		_employees.Add(newEmployee);

		return newEmployee.Id;
	}
}
