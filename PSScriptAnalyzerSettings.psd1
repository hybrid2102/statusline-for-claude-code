@{
    Severity = @('Error', 'Warning')

    ExcludeRules = @(
        # The installer is a console tool whose output IS the user interface: coloured
        # status lines are the point, and Write-Output/Write-Information would lose the
        # formatting the whole experience depends on.
        'PSAvoidUsingWriteHost',

        # False positive on the Pester tests: variables assigned in BeforeEach are read
        # inside the It blocks through Pester's scoping, which the rule does not follow.
        'PSUseDeclaredVarsMoreThanAssignments'
    )

    Rules = @{
        PSUseCompatibleSyntax = @{
            Enable         = $true
            TargetVersions = @('5.1', '7.0')
        }
    }
}
